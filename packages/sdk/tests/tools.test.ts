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

type Step = { changes?: Partial<TrajectoryChanges>; status: TrajectoryStatus };

function fakeClient(steps: Step[], postStatus = 200) {
  const posts: unknown[] = [];
  let changesIdx = 0;
  let statusIdx = 0;
  const client = {
    sessions: {
      getSessionChanges: async () => {
        const step = steps[Math.min(changesIdx++, steps.length - 1)];
        return { status: step.status, newEvents: [], answer: null, ...step.changes } as TrajectoryChanges;
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
  it("targets agent.tools on an inline agent", () => {
    const params = attachToolDefinitions({ agent: { name: "a", environments: [] } as never }, [add]);
    expect((params.agent as Record<string, unknown>)["tools"]).toEqual([toolDefinition(add)]);
  });

  it("targets overrides for a referenced agent", () => {
    const params = attachToolDefinitions({ agent: "h/web-surfer" }, [add]);
    expect(params.agent).toBe("h/web-surfer");
    expect(params.overrides).toEqual({ "agent.tools": [toolDefinition(add)] });
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
      { status: "running", changes: { newEvents: [awaitingEvent(pending)] } },
      { status: "running", changes: { newEvents: [awaitingEvent(pending)] } },
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
      { status: "running", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
      { status: "completed" },
    ]);

    await waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 });

    expect(posts).toEqual([{ type: "tool_result", tool_call_id: "c1", result: 2, is_error: false }]);
  });

  it("tolerates 409 from tool_results when the session already finished", async () => {
    const { client } = fakeClient(
      [
        { status: "running", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
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
        { status: "running", changes: { newEvents: [awaitingEvent([{ id: "c1", name: "add", arguments: { a: 1, b: 1 } }])] } },
        { status: "completed" },
      ],
      500,
    );

    await expect(waitForSession(client, { id: "s1", tools: [add], waitForSeconds: 0 })).rejects.toThrow(/HTTP 500/);
  });

  it("rejects tools with includeEvents=false", async () => {
    const { client } = fakeClient([{ status: "completed" }]);
    await expect(waitForSession(client, { id: "s1", tools: [add], includeEvents: false })).rejects.toThrow(
      /includeEvents/,
    );
  });
});
