/**
 * test_tools.py, the half the platform's overlays carry: tools.ts' error texts (`tool`, `asTools`) and polling.ts'
 * `postToolResults` (the batch envelope, the 409 and the transient retries of the post, the unregistered-tool
 * error). Lands with the platform's client sync; until then this file waits in pending/.
 */
import { expect, it } from "vitest";

import { HaiAgentsError, runSession, tool } from "hai-agents";
import { postToolResults } from "hai-agents-src/client/polling";
// Internal in the TS SDK (Python's tools.py exposes the same check on the decorator).
import { asTools } from "hai-agents-src/client/tools";

import { raises, raisesAsync } from "./helpers";
import { _FakeHttpx, _FakeSessions, _awaitingChanges, _pending, clientWith, get_weather } from "./tools_fakes";

it("tool without description raises", () => {
  raises(
    () =>
      tool({
        name: "nameless",
        inputSchema: { type: "object", properties: { x: { type: "integer" } } },
        fn: ({ x }: { x: unknown }) => x,
      } as never),
    Error,
    // Python: "needs a description: add a docstring or pass description="; TS has neither, so its text differs.
    /needs a non-empty description/,
  );
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
