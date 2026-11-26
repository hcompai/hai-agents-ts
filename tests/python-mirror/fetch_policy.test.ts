import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Client } from "./client";

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
// The resend of a dropped request and ApiError's text wait for the platform's client sync: pending/fetch_policy_overlay.test.ts.
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
