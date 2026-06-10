import { describe, expect, it } from "vitest";

import type { HaiAgentsClient } from "../src/client/Client.js";
import type { TrajectoryChanges, TrajectoryStatus } from "../src/client/api/index.js";
import { attachToolDefinitions, waitForSession } from "../src/client/polling.js";
import { asTools, tool, toolDefinition } from "../src/client/tools.js";

const add = tool({
  name: "add",
  description: "Add two numbers.",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  fn: ({ a, b }) => (a as number) + (b as number),
});

const boom = tool({
  name: "boom",
  description: "Always fails.",
  inputSchema: { type: "object", properties: {} },
  fn: () => {
    throw new Error("kaput");
  },
});

function awaitingEvent(calls: { id: string; name: string; arguments?: Record<string, unknown> }[]) {
  return {
    type: "ActiveStateChangeEvent",
    data: { state: "awaiting_tool_results", pending_tool_calls: calls },
    timestamp: new Date(),
  };
}

type Step = { changes?: Partial<TrajectoryChanges>; status: TrajectoryStatus | "awaiting_tool_results" };

function fakeClient(steps: Step[], postStatus = 200) {
  const posts: unknown[] = [];
  let changesIdx = 0;
  let statusIdx = 0;
  const client = {
    sessions: {
      getSessionChanges: async () => {
        const step = steps[Math.min(changesIdx++, steps.length - 1)];
        return { status: step.status, newEvents: [], answer: null, ...step.changes } as unknown as TrajectoryChanges;
      },
      getSessionStatus: async () => ({ status: steps[Math.min(statusIdx++, steps.length - 1)].status }),
    },
    fetch: async (_input: unknown, init?: { body?: string }) => {
      posts.push(JSON.parse(init?.body ?? "null"));
      return new Response("", { status: postStatus });
    },
  } as unknown as HaiAgentsClient;
  return { client, posts };
}

describe("attachToolDefinitions", () => {
  it("targets the agent.tools override for referenced and inline agents", () => {
    const expected = { "agent.tools": [{ name: add.name, description: add.description, input_schema: add.inputSchema }] };
    const referenced = attachToolDefinitions({ agent: "h/web-surfer" }, [add]);
    expect(referenced.agent).toBe("h/web-surfer");
    expect(referenced.overrides).toEqual(expected);
    const inline = attachToolDefinitions({ agent: { name: "a", environments: [] } as never }, [add]);
    expect(inline.overrides).toEqual(expected);
  });
});

describe("asTools", () => {
  it("rejects duplicate names", () => {
    expect(() => asTools([add, add])).toThrow(/Duplicate tool names: add/);
  });
});

describe("waitForSession tool dispatch", () => {
  it("executes pending calls exactly once and posts a batch", async () => {
    const pending = [
      { id: "c1", name: "add", arguments: { a: 2, b: 3 } },
      { id: "c2", name: "boom" },
      { id: "c3", name: "ghost" },
    ];
    const { client, posts } = fakeClient([
      { status: "awaiting_tool_results", changes: { newEvents: [awaitingEvent(pending)] } },
      { status: "awaiting_tool_results", changes: { newEvents: [awaitingEvent(pending)] } },
      { status: "completed", changes: { answer: "done" } },
    ]);

    const result = await waitForSession(client, { id: "s1", tools: [add, boom], waitForSeconds: 0 });

    expect(result.status).toBe("completed");
    expect(posts).toHaveLength(1);
    const body = posts[0] as { type: string; results: { tool_call_id: string; result: unknown; is_error: boolean }[] };
    expect(body.type).toBe("batch");
    expect(body.results).toEqual([
      { type: "tool_result", tool_call_id: "c1", result: 5, is_error: false },
      { type: "tool_result", tool_call_id: "c2", result: "Error: kaput", is_error: true },
      { type: "tool_result", tool_call_id: "c3", result: 'Tool "ghost" is not registered with this client.', is_error: true },
    ]);
  });

  it("posts a single result without batch wrapping", async () => {
    const { client, posts } = fakeClient([
      { status: "awaiting_tool_results", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
      { status: "completed" },
    ]);

    await waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 });

    expect(posts).toEqual([{ type: "tool_result", tool_call_id: "c1", result: 2, is_error: false }]);
  });

  it("tolerates 409 from tool_results when the session already finished", async () => {
    const { client } = fakeClient(
      [
        { status: "awaiting_tool_results", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
        { status: "completed" },
      ],
      409,
    );

    const result = await waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 });
    expect(result.status).toBe("completed");
  });

  it("throws on a non-409 post failure", async () => {
    const { client } = fakeClient(
      [
        { status: "awaiting_tool_results", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
        { status: "completed" },
      ],
      500,
    );

    await expect(waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 })).rejects.toThrow(/HTTP 500/);
  });

  it("executes only the latest advertised pending list", async () => {
    const stale = awaitingEvent([
      { id: "c1", name: "add", arguments: { a: 1, b: 1 } },
      { id: "c2", name: "add", arguments: { a: 2, b: 2 } },
    ]);
    const refreshed = awaitingEvent([{ id: "c2", name: "add", arguments: { a: 2, b: 2 } }]);
    const { client, posts } = fakeClient([
      { status: "awaiting_tool_results", changes: { newEvents: [stale, refreshed] } },
      { status: "completed" },
    ]);

    await waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 });

    expect(posts).toEqual([{ type: "tool_result", tool_call_id: "c2", result: 4, is_error: false }]);
  });

  it("recovers pending calls when joining past the advertising event", async () => {
    const pending = [{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }];
    const statuses = ["awaiting_tool_results", "completed"];
    let statusIdx = 0;
    const posts: unknown[] = [];
    const client = {
      sessions: {
        getSessionChanges: async ({ fromIndex }: { fromIndex?: number }) =>
          fromIndex === 0
            ? ({ newEvents: [awaitingEvent(pending)], answer: "done" } as unknown as TrajectoryChanges)
            : null,
        getSessionStatus: async () => ({ status: statuses[Math.min(statusIdx++, statuses.length - 1)] }),
      },
      fetch: async (_input: unknown, init?: { body?: string }) => {
        posts.push(JSON.parse(init?.body ?? "null"));
        return new Response("", { status: 200 });
      },
    } as unknown as HaiAgentsClient;

    const result = await waitForSession(client, { id: "s1", fromIndex: 9, tools: [add], waitForSeconds: 0 });

    expect(result.status).toBe("completed");
    expect(posts).toHaveLength(1);
    expect((posts[0] as { tool_call_id: string }).tool_call_id).toBe("c1");
  });

  it("does not dispatch when the live status left awaiting_tool_results", async () => {
    const { client, posts } = fakeClient([
      { status: "running", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
      { status: "completed" },
    ]);

    await waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 });

    expect(posts).toEqual([]);
  });

  it("rejects tools with includeEvents=false", async () => {
    const { client } = fakeClient([{ status: "completed" }]);
    await expect(waitForSession(client, { id: "s1", tools: [add], includeEvents: false })).rejects.toThrow(
      /includeEvents/,
    );
  });
});
