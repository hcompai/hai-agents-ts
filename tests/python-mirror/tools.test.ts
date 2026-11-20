/** Custom tool schema derivation and the dispatch loop, offline. */
import { expect, it } from "vitest";

import { z } from "zod";

import { HaiAgentsError, attachToolDefinitions, runSession, tool, toolDefinition, waitForSession } from "hai-agents";
import { postToolResults } from "hai-agents-src/client/polling";
// Internal in the TS SDK (Python's tools.py exposes the same check on the decorator).
import { asTools } from "hai-agents-src/client/tools";

import { raises, raisesAsync } from "./helpers";

const get_weather = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", default: "celsius" } }, required: ["city"] },
  fn: ({ city, unit = "celsius" }) => `Sunny in ${city} (${unit})`,
});

it("tool without description raises", () => {
  raises(
    () =>
      tool({
        name: "nameless",
        inputSchema: { type: "object", properties: { x: { type: "integer" } } },
        fn: ({ x }: { x: unknown }) => x,
      } as never),
    Error,
    /needs a description/,
  );
});

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

interface RecordedRequest {
  path: string;
  method: string;
  json: unknown;
  request_options: unknown;
}

/** The client's passthrough `fetch`, recording every tool-result post and answering from a status queue. */
class _FakeHttpx {
  requests: RecordedRequest[] = [];
  private statuses: number[];

  constructor(statuses?: number[]) {
    this.statuses = [...(statuses ?? [])];
  }

  fetch = async (input: string | URL | Request, init?: RequestInit, requestOptions?: unknown): Promise<Response> => {
    this.requests.push({
      path: String(input),
      method: init?.method ?? "GET",
      json: init?.body ? JSON.parse(String(init.body)) : null,
      request_options: requestOptions,
    });
    const status = this.statuses.length ? this.statuses.shift()! : 202;
    return new Response("", { status });
  };
}

type Poll = [unknown, string];

class _FakeSessions {
  private polls: Poll[];
  createdWith: Record<string, any> | null = null;

  constructor(polls: Poll[]) {
    this.polls = [...polls];
  }

  createSession(request: { idempotencyKey?: string | null; body: Record<string, unknown> }) {
    this.createdWith = request.body;
    return { id: "sess_1" };
  }

  getSessionChanges(_request: object) {
    return this.polls.length ? this.polls[0][0] : null;
  }

  getSessionStatus(_request: object) {
    const [, status] = this.polls.shift()!;
    return { status, outcome: null, error: null, errorCode: null };
  }
}

/** A pending tool call exactly as the serde layer hands it to the loop: a ToolRequest of {toolName, args, id}. */
function _pending(id: string, toolName: string, args: Record<string, unknown> | null = null) {
  return { id, toolName, args: args ?? {} };
}

function _awaitingChanges(...calls: ReturnType<typeof _pending>[]) {
  const event = {
    type: "ActiveStateChangeEvent",
    data: { state: "awaiting_tool_results", pendingToolCalls: [...calls] },
  };
  return { newEvents: [event], answer: null };
}

const clientWith = (sessions: unknown, httpx: _FakeHttpx) => ({ sessions, fetch: httpx.fetch }) as never;

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

it("post accepts 409 without retrying", async () => {
  const httpx = new _FakeHttpx([409]);
  const client = { fetch: httpx.fetch } as never;
  await postToolResults(client, "sess_1", [{ kind: "tool_result", tool_req: { tool_name: "t", args: {}, id: "c1" }, result: "" }]);
  expect(httpx.requests.length).toBe(1);
  expect(httpx.requests[0].request_options).toEqual({ maxRetries: 0 });
});

it("post retries transient errors", async () => {
  const httpx = new _FakeHttpx([500, 202]);
  const client = { fetch: httpx.fetch } as never;
  await postToolResults(client, "sess_1", [{ kind: "tool_result", tool_req: { tool_name: "t", args: {}, id: "c1" }, result: "" }]);
  expect(httpx.requests.length).toBe(2);
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

// Python has the code path but no test (hai_agents/tools.py:85-87); candidate to upstream.
it("as tools rejects duplicate names", () => {
  raises(() => asTools([get_weather, get_weather]), Error, /Duplicate tool names: \['get_weather'\]\./);
});

// Python has the code path but no loop-level test (hai_agents/polling.py `_post_tool_results`, tested on
// the private helper only, see the Dropped table); candidate to upstream.
it("run session posts several results as one batch and answers an unknown tool with an error", async () => {
  const broken = tool({
    name: "broken",
    description: "always fails",
    inputSchema: { type: "object", properties: {} },
    fn: () => {
      throw new Error("boom");
    },
  });
  const pending = [_pending("c1", "get_weather", { city: "Paris" }), _pending("c2", "broken"), _pending("c3", "ghost")];
  const sessions = new _FakeSessions([
    [_awaitingChanges(...pending), "awaiting_tool_results"],
    [_awaitingChanges(...pending), "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const httpx = new _FakeHttpx();
  const client = clientWith(sessions, httpx);

  const result = await runSession(client, { agent: "h/researcher", tools: [get_weather, broken] });

  expect(result.status).toBe("completed");
  expect(httpx.requests.length).toBe(1);
  expect(httpx.requests[0].json).toEqual({
    type: "batch",
    results: [
      { kind: "tool_result", tool_req: { tool_name: "get_weather", args: { city: "Paris" }, id: "c1" }, result: "Sunny in Paris (celsius)" },
      { kind: "error_event", error: "Error: boom", origin: "client", tool_req: { tool_name: "broken", args: {}, id: "c2" } },
      {
        kind: "error_event",
        error: "Tool 'ghost' is not registered with this client.",
        origin: "client",
        tool_req: { tool_name: "ghost", args: {}, id: "c3" },
      },
    ],
  });
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

// Python has the code path but no loop-level test (hai_agents/polling.py's _raise_unless_posted
// raises ApiError on any other post failure); candidate to upstream.
it("run session raises on a non 409 post failure", async () => {
  const sessions = new _FakeSessions([
    [_awaitingChanges(_pending("c1", "get_weather", { city: "Paris" })), "awaiting_tool_results"],
    [null, "completed"],
  ]);
  const client = clientWith(sessions, new _FakeHttpx([400]));

  // hai_agents.core.api_error.ApiError, whose __str__ is the headers, the status and the body
  const error = await raisesAsync(() => runSession(client, { agent: "h/researcher", tools: [get_weather] }), HaiAgentsError, /status_code: 400/);
  expect(error.statusCode).toBe(400);
});

// Python has the guard (hai_agents/polling.py:578) but no test; candidate to upstream.
it("wait with tools rejects include events false", async () => {
  const sessions = new _FakeSessions([[null, "completed"]]);
  const client = clientWith(sessions, new _FakeHttpx());

  await raisesAsync(() => waitForSession(client, { id: "sess_1", tools: [get_weather], includeEvents: false }), Error, /includeEvents/);
});
