/**
 * Custom tool schema derivation and the dispatch loop, offline. The fakes are in tools_fakes.ts, shared with
 * pending/tools_overlay.test.ts: the tests of what the platform's overlays carry (tools.ts' texts, polling.ts'
 * `postToolResults`), which wait for the platform's client sync.
 */
import { expect, it } from "vitest";

import { z } from "zod";

import { attachToolDefinitions, runSession, tool, toolDefinition, waitForSession } from "hai-agents";

import { raisesAsync } from "./helpers";
import { _FakeHttpx, _FakeSessions, _awaitingChanges, _pending, clientWith, get_weather } from "./tools_fakes";

// Adapted from test_tools.py::test_tool_decorator_derives_schema. The Python decorator derives the
// JSON schema from the function's type hints; the TS tool() takes the schema explicitly and `Tool`
// is a type, not a class. What is kept: the schema shape the agent sees and the call result.
it("tool with explicit schema keeps the shape the agent sees", () => {
  expect(get_weather.name).toBe("get_weather");
  expect(get_weather.description).toBe("Get the current weather for a city.");
  const schema = get_weather.inputSchema as Record<string, any>;
  expect(schema.type).toBe("object");
  expect(new Set(Object.keys(schema.properties))).toEqual(new Set(["city", "unit"]));
  expect(schema.required).toEqual(["city"]);
  expect((toolDefinition(get_weather) as Record<string, any>).input_schema).toBe(get_weather.inputSchema);
  expect(get_weather.fn({ city: "Paris" })).toBe("Sunny in Paris (celsius)");
});

// Adapted from test_tools.py::test_tool_decorator_with_args_returns_tool_and_applies_overrides. The
// Python form passes a pydantic model as `input`; the TS form passes a zod schema converted with
// z.toJSONSchema. Name and description overrides are what both forms must honour.
it("tool with a zod schema returns tool and applies overrides", () => {
  const whatever = tool({
    name: "weather_lookup",
    description: "Look up the weather.",
    inputSchema: z.toJSONSchema(z.object({ city: z.string() })),
    fn: ({ city }) => city,
  });

  expect(whatever.name).toBe("weather_lookup");
  expect(whatever.description).toBe("Look up the weather.");
  const schema = whatever.inputSchema as Record<string, any>;
  expect(schema.type).toBe("object");
  expect(schema.properties.city.type).toBe("string");
  expect(schema.required).toEqual(["city"]);
  expect(whatever.fn({ city: "Paris" })).toBe("Paris");
});

it("attach definitions string agent uses overrides", () => {
  const params: Record<string, any> = attachToolDefinitions({ agent: "h/researcher" }, [get_weather]);
  expect(params.agent).toBe("h/researcher");
  expect(params.overrides["agent.tools"]).toEqual([toolDefinition(get_weather)]);
});

it("attach definitions inline agent carries tools", () => {
  const agent = { name: "mine", description: "d", environments: [] };
  const params: Record<string, any> = attachToolDefinitions({ agent: { ...agent } } as never, [get_weather]);
  expect(params.agent).toEqual({ ...agent, tools: [{ name: get_weather.name, description: get_weather.description, inputSchema: get_weather.inputSchema }] });
  expect("overrides" in params).toBe(false);
});

it("wait without tools stops when session awaits tool results", async () => {
  const sessions = new _FakeSessions([[_awaitingChanges(_pending("c1", "get_weather")), "awaiting_tool_results"]]);

  const result = await waitForSession({ sessions } as never, { id: "sess_1" });

  expect(result.status).toBe("awaiting_tool_results");
});

it("run session dispatches pending calls and posts results", async () => {
  const sessions = new _FakeSessions([
    [_awaitingChanges(_pending("c1", "get_weather", { city: "Paris" })), "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const httpx = new _FakeHttpx();
  const client = clientWith(sessions, httpx);

  const result = await runSession(client, { agent: "h/researcher", tools: [get_weather] });

  expect(sessions.createdWith!.overrides["agent.tools"]).toEqual([toolDefinition(get_weather)]);
  expect(httpx.requests.map((r) => r.path)).toEqual(["api/v2/sessions/sess_1/tool_results"]);
  expect(httpx.requests[0].json).toEqual({
    kind: "tool_result",
    tool_req: { tool_name: "get_weather", args: { city: "Paris" }, id: "c1" },
    result: "Sunny in Paris (celsius)",
  });
  expect(result.status).toBe("completed");
});

it("dispatch reports tool exceptions as errors", async () => {
  const broken = tool({
    name: "broken",
    description: "always fails",
    inputSchema: { type: "object", properties: {} },
    fn: () => {
      throw new Error("boom");
    },
  });

  const sessions = new _FakeSessions([
    [_awaitingChanges(_pending("c1", "broken")), "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const httpx = new _FakeHttpx();
  const client = clientWith(sessions, httpx);

  await runSession(client, { agent: "h/researcher", tools: [broken] });

  expect(httpx.requests[0].json).toEqual({
    kind: "error_event",
    error: "Error: boom",
    origin: "client",
    tool_req: { tool_name: "broken", args: {}, id: "c1" },
  });
});

it("sync path awaits async tools", async () => {
  const lookup = tool({
    name: "lookup",
    description: "async lookup",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
    fn: async ({ key }) => `value:${key}`,
  });

  const sessions = new _FakeSessions([
    [_awaitingChanges(_pending("c1", "lookup", { key: "k" })), "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const httpx = new _FakeHttpx();
  const client = clientWith(sessions, httpx);

  await runSession(client, { agent: "h/researcher", tools: [lookup] });

  expect((httpx.requests[0].json as Record<string, unknown>).result).toBe("value:k");
  expect((httpx.requests[0].json as Record<string, unknown>).kind).toBe("tool_result");
});

it("settled and replayed calls are not re executed", async () => {
  const stale = {
    type: "ActiveStateChangeEvent",
    data: {
      state: "awaiting_tool_results",
      pendingToolCalls: [_pending("c1", "get_weather", { city: "Paris" }), _pending("c2", "get_weather", { city: "Tokyo" })],
    },
  };
  const refreshed = {
    type: "ActiveStateChangeEvent",
    data: { state: "awaiting_tool_results", pendingToolCalls: [_pending("c2", "get_weather", { city: "Tokyo" })] },
  };
  const changes = { newEvents: [stale, refreshed], answer: null };
  const sessions = new _FakeSessions([
    [changes, "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const httpx = new _FakeHttpx();
  const client = clientWith(sessions, httpx);

  await runSession(client, { agent: "h/researcher", tools: [get_weather] });

  expect(httpx.requests.length).toBe(1);
  expect((httpx.requests[0].json as any).tool_req.id).toBe("c2");
});

it("wait joining past advertisement recovers pending", async () => {
  class _MidStreamSessions {
    private statuses = ["awaiting_tool_results", "completed"];

    getSessionChanges({ fromIndex }: { fromIndex?: number }) {
      if (fromIndex === 0) return _awaitingChanges(_pending("c1", "get_weather", { city: "Paris" }));
      return null;
    }

    getSessionStatus(_request: object) {
      return { status: this.statuses.shift()!, outcome: null, error: null, errorCode: null };
    }
  }

  const httpx = new _FakeHttpx();
  const client = clientWith(new _MidStreamSessions(), httpx);

  const result = await waitForSession(client, { id: "sess_1", fromIndex: 9, tools: [get_weather] });

  expect(httpx.requests.map((r) => (r.json as any).tool_req.id)).toEqual(["c1"]);
  expect(result.status).toBe("completed");
});

it("no dispatch when status left awaiting", async () => {
  const resumed = {
    type: "ActiveStateChangeEvent",
    data: { state: "awaiting_tool_results", pendingToolCalls: [_pending("c1", "get_weather", { city: "Paris" })] },
  };
  const changes = { newEvents: [resumed], answer: null };
  const sessions = new _FakeSessions([
    [changes, "running"],
    [null, "completed"],
  ]);
  const httpx = new _FakeHttpx();
  const client = clientWith(sessions, httpx);

  await runSession(client, { agent: "h/researcher", tools: [get_weather] });

  expect(httpx.requests).toEqual([]);
});

// Python has the code path but no loop-level test (hai_agents/polling.py accepts a 409 on the post:
// the session already moved on); candidate to upstream.
it("run session tolerates 409 from tool results when the session already finished", async () => {
  const sessions = new _FakeSessions([
    [_awaitingChanges(_pending("c1", "get_weather", { city: "Paris" })), "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const client = clientWith(sessions, new _FakeHttpx([409]));

  const result = await runSession(client, { agent: "h/researcher", tools: [get_weather] });

  expect(result.status).toBe("completed");
});

// Python has the guard (hai_agents/polling.py:578) but no test; candidate to upstream.
it("wait with tools rejects include events false", async () => {
  const sessions = new _FakeSessions([[null, "completed"]]);
  const client = clientWith(sessions, new _FakeHttpx());

  await raisesAsync(() => waitForSession(client, { id: "sess_1", tools: [get_weather], includeEvents: false }), Error, /includeEvents/);
});
