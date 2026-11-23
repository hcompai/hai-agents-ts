import { describe, expect, it } from "vitest";

import { HaiAgentsClient, HaiAgentsError, HaiAgentsTimeoutError } from "../src/index.js";

// The fetch layer decides what a caller sees on a bad day: which failures are re-sent,
// what an error reads like, and whether a timeout is recognisable as one.

type Reply = { status: number; body?: string; headers?: Record<string, string> };

function clientReplying(replies: Reply[]) {
  const calls: { method: string; url: string }[] = [];
  const client = new HaiAgentsClient({
    apiKey: "k",
    baseUrl: "https://api.test",
    maxRetries: 2,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return new Response(reply.body ?? null, {
        status: reply.status,
        headers: { "Content-Type": "application/json", ...reply.headers },
      });
    },
  });
  return { client, calls };
}

const status = { status: "idle", steps: 0 };
const retryAfter = { "Retry-After": "1" };

describe("retries", () => {
  it("re-sends a GET that hit a 5xx", async () => {
    const { client, calls } = clientReplying([{ status: 503, headers: retryAfter }, { status: 200, body: JSON.stringify(status) }]);
    await client.sessions.getSessionStatus({ id: "s1" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("never re-sends a POST that hit a 5xx, since it may have landed", async () => {
    const { client, calls } = clientReplying([{ status: 503, headers: retryAfter }]);
    await expect(client.sessions.pauseSession({ id: "s1" })).rejects.toBeInstanceOf(HaiAgentsError);
    expect(calls).toEqual([{ method: "POST", url: "https://api.test/api/v2/sessions/s1/pause" }]);
  });

  it("re-sends a POST that was rate limited, since nothing was admitted", async () => {
    const { client, calls } = clientReplying([{ status: 429, headers: retryAfter }, { status: 200, body: JSON.stringify(status) }]);
    await client.sessions.pauseSession({ id: "s1" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });
});

describe("errors", () => {
  it("leads with the server's detail", async () => {
    const body = { message: "Session s1 not found", detail: [{ type: "not_found", message: "Session s1 not found" }] };
    const { client } = clientReplying([{ status: 404, body: JSON.stringify(body) }]);
    const error = await client.sessions.getSessionStatus({ id: "s1" }).catch((e: unknown) => e as HaiAgentsError);
    expect(error).toBeInstanceOf(HaiAgentsError);
    expect(error.message.split("\n")).toEqual(["Session s1 not found", "Status code: 404"]);
    expect(error.body).toEqual(body);
  });

  it("falls back to the body when there is no detail to lift", () => {
    const error = new HaiAgentsError({ statusCode: 500, body: { oops: true } });
    expect(error.message).toBe('Status code: 500\nBody: {\n  "oops": true\n}');
  });

  it("rejects a 2xx whose body is not JSON instead of returning it as the payload", async () => {
    const { client } = clientReplying([{ status: 200, body: "<html>gateway</html>", headers: { "Content-Type": "text/html" } }]);
    const error = await client.sessions.getSessionStatus({ id: "s1" }).catch((e: unknown) => e as HaiAgentsError);
    expect(error).toBeInstanceOf(HaiAgentsError);
    expect(error.statusCode).toBe(200);
    expect(error.body).toBe("<html>gateway</html>");
  });

  it("surfaces a timeout as HaiAgentsTimeoutError", async () => {
    const client = new HaiAgentsClient({
      apiKey: "k",
      baseUrl: "https://api.test",
      maxRetries: 0,
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    const error = await client.sessions.getSessionStatus({ id: "s1" }, { timeoutInSeconds: 0.01 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HaiAgentsTimeoutError);
  });
});
