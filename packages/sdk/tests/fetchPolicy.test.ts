import { describe, expect, it } from "vitest";

import { Client, HaiAgentsError, HaiAgentsTimeoutError } from "../src/index.js";

// What only the TS client does on a bad day; the policy shared with Python is tested in
// tests/python-mirror/fetch_policy.test.ts.

type Reply = { status: number; body?: string; headers?: Record<string, string> };

function clientReplying(replies: Reply[]) {
  const calls: { method: string; url: string }[] = [];
  const client = new Client({
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

describe("generated methods", () => {
  it("never re-sends a POST that hit a 5xx, since it may have landed", async () => {
    const { client, calls } = clientReplying([{ status: 503, headers: { "Retry-After": "1" } }]);
    await expect(client.sessions.pauseSession({ id: "s1" })).rejects.toBeInstanceOf(HaiAgentsError);
    expect(calls).toEqual([{ method: "POST", url: "https://api.test/api/v2/sessions/s1/pause" }]);
  });

  it("lead with the server's detail and keep the parsed body", async () => {
    const body = { message: "Session s1 not found", detail: [{ type: "not_found", message: "Session s1 not found" }] };
    const { client } = clientReplying([{ status: 404, body: JSON.stringify(body) }]);
    const error = await client.sessions.getSessionStatus({ id: "s1" }).catch((e: unknown) => e as HaiAgentsError);
    expect(error).toBeInstanceOf(HaiAgentsError);
    expect(error.message).toBe("Session s1 not found (status_code: 404)");
    expect(error.body).toEqual(body);
  });

  it("reject a 2xx whose body is not JSON instead of returning it as the payload", async () => {
    const { client } = clientReplying([{ status: 200, body: "<html>gateway</html>", headers: { "Content-Type": "text/html" } }]);
    const error = await client.sessions.getSessionStatus({ id: "s1" }).catch((e: unknown) => e as HaiAgentsError);
    expect(error).toBeInstanceOf(HaiAgentsError);
    expect(error.statusCode).toBe(200);
    expect(error.body).toBe("<html>gateway</html>");
  });

  // A browser's `Failed to fetch` carries no cause: it counts as a mid-request drop, re-sent for idempotent methods only.
  it("re-send a TypeError without a cause for idempotent methods only", async () => {
    const failing = () => {
      let calls = 0;
      const client = new Client({
        apiKey: "k",
        baseUrl: "https://api.test",
        maxRetries: 2,
        fetch: async () => {
          calls += 1;
          if (calls === 1) throw new TypeError("Failed to fetch");
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });
      return { client, calls: () => calls };
    };
    let { client, calls } = failing();
    await expect(client.fetch("sessions", { method: "POST" })).rejects.toThrow(/Failed to fetch/);
    expect(calls()).toBe(1);
    ({ client, calls } = failing());
    expect((await client.fetch("sessions", { method: "GET" })).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("surface a timeout as HaiAgentsTimeoutError", async () => {
    const client = new Client({
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
