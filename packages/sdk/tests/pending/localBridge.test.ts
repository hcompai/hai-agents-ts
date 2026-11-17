// The bridge against a fake command channel: the routes AGP and the local runtime serve.

import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthError, CommandExchange, LocalBridge, serializeResult } from "../src/local/index.js";
import type { Command } from "../src/local/index.js";

type Posted = { commandId: string; body: Record<string, unknown> };

/** A command channel: queued commands go out on the next poll, results are collected. */
class FakeChannel {
  readonly server: Server;
  readonly channels = new Set<string>();
  readonly queue: Command[] = [];
  readonly results: Posted[] = [];
  readonly headers: IncomingMessage["headers"][] = [];
  /** Hold an empty poll for `wait_for_seconds`, as AGP does; off, it answers 204 at once. */
  holdPolls = false;
  /** The polls held open right now. */
  readonly held = new Set<() => void>();
  baseUrl = "";

  constructor() {
    this.server = createServer((req, res) => this.#handle(req, res));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Queue commands; a held poll returns them at once. */
  enqueue(...commands: Command[]): void {
    this.queue.push(...commands);
    for (const wake of this.held) wake();
  }

  /** Resolves once `count` results have been posted. */
  async wait(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.results.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`only ${this.results.length}/${count} results after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    this.headers.push(req.headers);
    const url = new URL(req.url ?? "/", this.baseUrl);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      const trajectory = url.pathname.match(/^\/api\/v1\/trajectories\/([^/]+)$/);
      if (trajectory && req.method === "GET") {
        res.writeHead(this.channels.has(trajectory[1]) ? 200 : 404).end("{}");
        return;
      }
      if (url.pathname === "/api/v1/trajectories/" && req.method === "POST") {
        this.channels.add(String(body.id));
        res.writeHead(201).end("{}");
        return;
      }
      if (/^\/api\/v1\/commands\/[^/]+\/commands$/.test(url.pathname)) {
        const waitMs = Number(url.searchParams.get("wait_for_seconds") ?? 0) * 1000;
        if (this.queue.length > 0 || !this.holdPolls || waitMs === 0) {
          this.#answerPoll(res);
          return;
        }
        const wake = () => {
          clearTimeout(timer);
          this.held.delete(wake);
          this.#answerPoll(res);
        };
        const timer = setTimeout(wake, waitMs);
        this.held.add(wake);
        res.on("close", () => {
          clearTimeout(timer);
          this.held.delete(wake);
        });
        return;
      }
      const result = url.pathname.match(/^\/api\/v1\/commands\/([^/]+)\/result$/);
      if (result && req.method === "POST") {
        this.results.push({ commandId: result[1], body });
        res.writeHead(200).end("{}");
        return;
      }
      res.writeHead(404).end();
    });
  }

  #answerPoll(res: ServerResponse): void {
    if (res.writableEnded) {
      return;
    }
    const batch = this.queue.splice(0);
    if (batch.length === 0) {
      res.writeHead(204).end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(batch));
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const channel = new FakeChannel();
beforeAll(() => channel.listen());
afterAll(() => channel.close());

describe("LocalBridge", () => {
  it("registers its channel, serves commands through the driver and posts results", async () => {
    const calls: string[] = [];
    const bridge = new LocalBridge({
      baseUrl: channel.baseUrl,
      apiKey: "hk-test",
      driver: {
        dispatch: async (name, args) => {
          calls.push(name);
          if (name === "boom") {
            throw new Error("the page is gone");
          }
          return { echoed: args };
        },
      },
    });
    await bridge.start();
    expect(channel.channels.has(bridge.sessionId)).toBe(true);
    // Authorization and Accept only, as the Python bridge sends.
    expect(channel.headers[0].authorization).toBe("Bearer hk-test");
    expect(channel.headers[0].accept).toBe("application/json");
    expect(Object.keys(channel.headers[0]).filter((name) => name.startsWith("x-hcompany"))).toEqual([]);

    channel.enqueue(
      { id: "c1", command_uid: "u1", name: "click_at", args: { x: 1, y: 2 } },
      { id: "c2", command_uid: "u2", name: "boom", args: {} },
      { id: "c3", command_uid: "u1", name: "click_at", args: { x: 1, y: 2 } }, // redelivery of u1
    );
    await channel.wait(3);
    await bridge.stop();

    expect(calls).toEqual(["click_at", "boom"]); // the redelivery was not run again
    expect(channel.results[0]).toEqual({
      commandId: "c1",
      body: { result: { echoed: { x: 1, y: 2 } }, error: null, command_uid: "u1" },
    });
    expect(channel.results[1].body).toEqual({ result: null, error: "the page is gone", command_uid: "u2" });
    expect(channel.results[2].body).toEqual(channel.results[0].body);
  });

  // Python's bridge.py _process_commands returns without delivering once a stop is requested; its only test
  // of it drives the workstation bridge (test_stopping_workstation_interrupts_running_command_and_skips_queue).
  it("drops the result of a command a stop interrupted and skips the queue", async () => {
    const ran: string[] = [];
    let release = () => {};
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const dispatching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bridge = new LocalBridge({
      baseUrl: channel.baseUrl,
      apiKey: "hk-test",
      driver: {
        dispatch: async (name) => {
          ran.push(name);
          started();
          await running;
          return "done";
        },
      },
    });
    await bridge.start();
    const posted = channel.results.length;
    channel.enqueue({ id: "one", command_uid: "one", name: "slow", args: {} }, { id: "two", command_uid: "two", name: "queued", args: {} });
    await dispatching;
    const stopping = bridge.stop();
    release();
    await stopping;
    expect(ran).toEqual(["slow"]);
    expect(channel.results.length).toBe(posted);
  });

  // Each paced empty poll sleeps on the stop signal; a sleep the timer ends must leave no listener behind.
  it("leaves no abort listener behind once a sleep ends on its own", async () => {
    const signals = new Set<AbortSignal>();
    const addEventListener = EventTarget.prototype.addEventListener;
    vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, ...args) {
      if (this instanceof AbortSignal && args[0] === "abort") signals.add(this);
      return addEventListener.apply(this, args);
    });
    const polls = () => channel.headers.length;
    const bridge = new LocalBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", driver: { dispatch: async () => null } });
    try {
      await bridge.start();
      const seen = polls();
      const deadline = Date.now() + 5_000;
      while (polls() < seen + 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20)); // three instant 204s: two sleeps ended by their timer, one in flight
      }
      expect(polls()).toBeGreaterThanOrEqual(seen + 3);
      expect(Math.max(...[...signals].map((signal) => getEventListeners(signal, "abort").length))).toBeLessThanOrEqual(1);
    } finally {
      vi.restoreAllMocks();
      await bridge.stop();
    }
  });

  it("stops promptly while a long poll is in flight", async () => {
    channel.holdPolls = true;
    const bridge = new LocalBridge({
      baseUrl: channel.baseUrl,
      apiKey: "hk-test",
      driver: { dispatch: async () => null },
    });
    try {
      await bridge.start();
      const deadline = Date.now() + 2_000;
      while (channel.held.size === 0 && Date.now() < deadline) {
        await sleep(10);
      }
      expect(channel.held.size).toBe(1); // held for LONG_POLL_SECONDS unless the bridge abandons it
      const started = Date.now();
      await bridge.stop();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      channel.holdPolls = false;
    }
  });
});

describe("LocalBridge.start", () => {
  // fetch's TimeoutError is retried like httpx's timeout, an httpx.HTTPError in Python's _open_channel.
  it("retries a channel check that times out", async () => {
    let checks = 0;
    const timingOut: typeof fetch = async (input, init) => {
      if (/\/api\/v1\/trajectories\/[^/]+$/.test(String(input)) && (init?.method ?? "GET") === "GET" && checks++ === 0) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return fetch(input, init);
    };
    const bridge = new LocalBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", fetch: timingOut, driver: { dispatch: async () => null } });
    channel.channels.add(bridge.sessionId); // the second check answers 200
    await bridge.start();
    await bridge.stop();
    expect(checks).toBe(2);
  });

  it("retries a registration that fails transiently", async () => {
    let calls = 0;
    const flaky = createServer((req, res) => {
      calls += 1;
      if (req.method === "GET") {
        res.writeHead(404).end("{}"); // unknown channel: the bridge creates it
        return;
      }
      res.writeHead(calls === 2 ? 503 : 201).end("{}"); // the first create fails, the next succeeds
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const address = flaky.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    try {
      const bridge = new LocalBridge({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "hk-test",
        driver: { dispatch: async () => null },
      });
      await bridge.start();
      await bridge.stop();
      expect(calls).toBe(4); // GET, failed POST, GET, POST
    } finally {
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
    }
  });
});

describe("CommandExchange", () => {
  it("surfaces a rejected key as an auth error instead of retrying", async () => {
    const rejecting = createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    const address = rejecting.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    try {
      const exchange = new CommandExchange({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "bad" });
      await expect(exchange.ensureChannel("s1")).rejects.toBeInstanceOf(AuthError);
      await expect(exchange.fetchCommands("s1", { waitForSeconds: 0, readTimeoutMs: 1_000, maxRetries: 0 })).rejects.toBeInstanceOf(AuthError);
    } finally {
      await new Promise<void>((resolve) => rejecting.close(() => resolve()));
    }
  });
});

describe("serializeResult", () => {
  it("encodes bytes as base64 and recurses into plain containers", () => {
    expect(serializeResult({ png: new Uint8Array([1, 2, 3]), tabs: [1, "a", null, undefined] })).toEqual({
      png: "AQID",
      tabs: [1, "a", null, null],
    });
  });

  it("accepts the same object twice but refuses a cycle", () => {
    const shared = { x: 1 };
    expect(serializeResult([shared, shared])).toEqual([{ x: 1 }, { x: 1 }]);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => serializeResult(loop)).toThrow("circular reference");
  });

  it("names the type JSON cannot carry", () => {
    expect(() => serializeResult(new Date(0))).toThrow("Date");
    expect(() => serializeResult(Number.NaN)).toThrow(/^number$/); // Python: "float"
  });
});
