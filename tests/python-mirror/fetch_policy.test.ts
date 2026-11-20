import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { HaiAgents, Client, HaiAgentsError } from "hai-agents";

import { raisesAsync } from "./helpers";

/** httpx.MockTransport: a `fetch` that answers from a queue of statuses and records every request. */
function clientReturning(...statuses: number[]): [Client, Request[]] {
  const seen: Request[] = [];
  const queue = [...statuses];

  const handler: typeof fetch = async (input, init) => {
    seen.push(new Request(input, init));
    const status = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(JSON.stringify({}), { status, headers: { "content-type": "application/json" } });
  };

  const client = new Client({
    apiKey: "k",
    fetch: handler,
    baseUrl: "https://api.test",
    maxRetries: 2,
  });
  return [client, seen];
}

// no_sleep: the retry backoff runs on timers the test fast-forwards instead of waiting through.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function settled<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

/** Node's fetch rejects with `TypeError: fetch failed` and the socket error, with its `code`, on `cause`. */
function fetchFailed(code: string, message: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

/** A `fetch` whose first call rejects with `error`, then answers 200. */
function failingClient(error: Error): [Client, string[]] {
  const seen: string[] = [];

  const handler: typeof fetch = async (input, init) => {
    seen.push(new Request(input, init).method);
    if (seen.length === 1) throw error;
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new Client({ apiKey: "k", fetch: handler, baseUrl: "https://api.test", maxRetries: 2 });
  return [client, seen];
}

/** httpx.RemoteProtocolError: the connection died mid-flight. */
const serverDisconnected = () => fetchFailed("UND_ERR_SOCKET", "other side closed");

it("connection drop is resent only for idempotent methods", async () => {
  let [client, seen] = failingClient(serverDisconnected());
  await raisesAsync(() => client.fetch("sessions", { method: "POST" }), TypeError, /fetch failed/);
  expect(seen).toEqual(["POST"]);

  [client, seen] = failingClient(serverDisconnected());
  expect((await settled(client.fetch("sessions", { method: "GET" }))).status).toBe(200);
  expect(seen).toEqual(["GET", "GET"]);
});

// Python has the code path but no test (hai_agents/core/http_client.py:140-142, `_may_resend`); candidate to upstream.
it("connect error is resent for any method", async () => {
  // httpx.ConnectError: the request never reached the server.
  const [client, seen] = failingClient(fetchFailed("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"));
  expect((await settled(client.fetch("sessions", { method: "POST" }))).status).toBe(200);
  expect(seen).toEqual(["POST", "POST"]);
});

it("5xx is retried only for idempotent methods", async () => {
  let [client, seen] = clientReturning(503, 200);
  expect((await settled(client.fetch("sessions", { method: "GET" }))).status).toBe(200);
  expect(seen.length).toBe(2);

  [client, seen] = clientReturning(503, 200);
  expect((await settled(client.fetch("sessions", { method: "POST" }))).status).toBe(503);
  expect(seen.length).toBe(1);
});

it("429 is retried for any method", async () => {
  const [client, seen] = clientReturning(429, 200);
  expect((await settled(client.fetch("sessions", { method: "POST" }))).status).toBe(200);
  expect(seen.length).toBe(2);
});

it("409 is never retried", async () => {
  const [client, seen] = clientReturning(409, 200);
  expect((await settled(client.fetch("sessions", { method: "GET" }))).status).toBe(409);
  expect(seen.length).toBe(1);
});

it.each([
  [{ detail: "Quota exceeded" }, "Quota exceeded (status_code: 429)"],
  [{ message: "Not found" }, "Not found (status_code: 429)"],
  [{ detail: { message: "nested" } }, "nested (status_code: 429)"],
  [{ detail: [{ msg: "a" }, { msg: "b" }] }, "a; b (status_code: 429)"],
])("api error leads with server detail %j", (body, expected) => {
  expect(new HaiAgentsError({ statusCode: 429, body }).message).toBe(expected);
});

it("unprocessable entity reads error response", () => {
  const err = new HaiAgents.UnprocessableEntityError({
    message: "body.x: field required; body.y: not an int",
    detail: [
      { loc: ["body", "x"], msg: "field required", type: "missing" },
      { loc: ["body", "y"], msg: "not an int", type: "int_parsing" },
    ],
  });
  expect(err.message).toBe("field required; not an int (status_code: 422)");
});

it("api error without detail keeps full dump", () => {
  const rawResponse = { headers: new Headers({ x: "y" }) } as never;
  const err = new HaiAgentsError({ statusCode: 502, rawResponse, body: "<html>bad gateway</html>" });
  expect(err.message).toBe('headers: {"x":"y"}, status_code: 502, body: <html>bad gateway</html>');
});
