/**
 * test_local.py: TestChannelSetup, TestBridgeProtocol, TestDriverInterfaces (the browser half; the
 * desktop and workstation halves are dropped).
 *
 * Python drives the bridge through its private methods (_open_channel, _process_commands, _deliver,
 * _poll_loop) with a FakeExchange. The TS LocalBridge exposes start(), stop() and done, so every
 * test here runs the real bridge against a fake command channel (the routes AGP serves) and
 * asserts the same posted bodies: same ids, command_uids, results and errors as the Python tests.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthError, ChannelHttpError, LocalBridge } from "hai-agents/local";
import type { Command } from "hai-agents/local";

import { raisesAsync } from "./helpers";

// httpx.HTTPStatusError
const HTTPStatusError = ChannelHttpError;

type Args = Record<string, unknown>;
/** `httpx.Response(status, headers=, json=|text=)`: an object body goes out as JSON, a string as text, nothing as `{}`. */
type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

class FakeDriver {
  clicks = 0;

  async dispatch(name: string, args: Args): Promise<unknown> {
    switch (name) {
      case "click":
        this.clicks += 1;
        return null;
      case "execute_script":
        return { script: args.script, args: Array.isArray(args.args) ? args.args : [], attempts: args.n_unsafe_attempts ?? 2 };
      case "boom":
        throw new Error("kaboom");
      default:
        throw new Error(`${name} is not supported`);
    }
  }
}

/**
 * httpx.MockTransport for the command channel: command batches go out one per poll, result posts
 * are recorded and answered from `post_replies` in order; like Python's _serve, the bridge is told
 * to stop once the last reply is handed out.
 */
class FakeChannel {
  readonly server: Server;
  baseUrl = "";
  /** Statuses for the channel registration (GET /trajectories/{id}), in order; 200 once exhausted. */
  channel_replies: Reply[] = [];
  /** Session ids seen on registration requests. */
  ensures: string[] = [];
  paths: string[] = [];
  /** Statuses answered on /commands before any batch is served, in order. */
  command_replies: Reply[] = [];
  batches: Args[][] = [];
  post_replies: Reply[] = [];
  posts: Args[] = [];
  stop_requested = false;

  constructor() {
    this.server = createServer((req, res) => this.#handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", this.baseUrl).pathname;
    this.paths.push(path);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      const trajectory = path.match(/^\/api\/v1\/trajectories\/([^/]*)$/);
      if (trajectory) {
        this.ensures.push(req.method === "POST" ? String(body?.id) : trajectory[1]);
        const reply = this.channel_replies.shift() ?? { status: req.method === "POST" ? 201 : 200 };
        res.writeHead(reply.status, reply.headers).end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
        return;
      }
      if (path.endsWith("/commands")) {
        const reply = this.command_replies.shift();
        if (reply) {
          res.writeHead(reply.status, reply.headers).end("{}");
          return;
        }
        const batch = this.batches.shift();
        if (!batch) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(batch));
        return;
      }
      if (path.endsWith("/result")) {
        this.posts.push({ id: path.split("/").at(-2), ...body });
        if (this.post_replies.length === 1) this.stop_requested = true;
        const reply = this.post_replies.shift() ?? { status: 200 };
        res.writeHead(reply.status, reply.headers).end("{}");
        return;
      }
      res.writeHead(404).end();
    });
  }
}

let channel: FakeChannel;
beforeEach(async () => {
  channel = new FakeChannel();
  await channel.start();
});
afterEach(async () => {
  await channel.stop();
});

function _bridge(driver: FakeDriver, onLog?: (message: string) => void): LocalBridge {
  return new LocalBridge({ baseUrl: channel.baseUrl, apiKey: "k", driver, onLog });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll command batches in order, answer result posts in order, stop after the last reply; returns the posts. */
async function _serve(bridge: LocalBridge, batches: Args[][], post_replies: Reply[], timeoutMs = 8_000): Promise<Args[]> {
  channel.batches = batches;
  channel.post_replies = post_replies;
  await bridge.start();
  const done = bridge.done;
  done.catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  while (!channel.stop_requested && Date.now() < deadline) {
    await sleep(20);
  }
  await bridge.stop().catch(() => undefined); // stop() rethrows the serving error; the tests read it from `done`
  return channel.posts;
}

/** `with pytest.raises(T): await bridge._poll_loop(...)`: the serving loop ends with that error. */
async function pollLoopRaises(bridge: LocalBridge, type: new (...args: never[]) => Error, timeoutMs = 8_000): Promise<void> {
  await bridge.start();
  const done = bridge.done;
  done.catch(() => undefined);
  try {
    await raisesAsync(() => Promise.race([done, sleep(timeoutMs).then(() => "still serving")]), type);
  } finally {
    await bridge.stop().catch(() => undefined);
  }
}

function _click(command_id: string): Args {
  return { id: command_id, command_uid: command_id, name: "click", args: { x: 0, y: 0 } };
}

describe("ChannelSetup", () => {
  // Python: TestChannelSetup::test_429_is_retried_with_backoff_then_succeeds.
  it("429 is retried with backoff then succeeds", async () => {
    channel.channel_replies = [{ status: 429, headers: { "Retry-After": "0" } }, { status: 429, headers: { "Retry-After": "0" } }, { status: 200 }];

    const bridge = _bridge(new FakeDriver());
    await bridge.start();
    await bridge.stop();
    expect(channel.ensures.length).toBe(3);
    expect(channel.paths.filter((path) => path.includes("/trajectories/"))).toEqual(Array(3).fill(`/api/v1/trajectories/${bridge.sessionId}`));
  });

  // Python: TestChannelSetup::test_429_gives_up_with_a_clear_error.
  it("429 gives up with a clear error", async () => {
    channel.channel_replies = Array(10).fill({ status: 429, headers: { "Retry-After": "0" } });

    const bridge = _bridge(new FakeDriver());
    await raisesAsync(() => bridge.start(), Error, /rate-limiting/);
  });

  // Python: TestChannelSetup::test_429_gives_up_with_the_platforms_reason (its instant_sleep patch has no
  // TS hook; Retry-After 0 gives the 1s floor, as in "429 gives up with a clear error").
  it("429 gives up with the platforms reason", async () => {
    const full = { message: "capacity is temporarily full. Please try again later.", detail: [{ type: "capacity" }] };
    channel.channel_replies = Array(10).fill({ status: 429, headers: { "Retry-After": "0" }, body: full });

    const bridge = _bridge(new FakeDriver());
    await raisesAsync(() => bridge.start(), Error, "refused command-channel setup: capacity is temporarily full");
  });

  // Python: TestChannelSetup::test_errors_carry_the_platforms_words. httpx.HTTPStatusError is ChannelHttpError.
  it.each<[number, unknown, new (...args: never[]) => Error, string]>([
    [401, { message: "API key revoked" }, AuthError, "auth error checking channel (401): API key revoked"],
    [400, { detail: "unknown agent surferh" }, HTTPStatusError, "HTTP 400 from POST"],
    [400, { detail: "unknown agent surferh" }, HTTPStatusError, ": unknown agent surferh"],
    [400, "not json", HTTPStatusError, "HTTP 400 from POST /api/v1/trajectories/"],
  ])("errors carry the platforms words [%s %j]", async (status, body, error, words) => {
    // Python's responder answers the GET with a 404 when the status is 400, so the words come from the create POST.
    channel.channel_replies = status === 400 ? [{ status: 404 }, { status, body }] : [{ status, body }];

    const bridge = _bridge(new FakeDriver());
    await raisesAsync(() => bridge.start(), error, words);
  });

  it("auth error is not retried", async () => {
    channel.channel_replies = [{ status: 401 }];

    const bridge = _bridge(new FakeDriver());
    await raisesAsync(() => bridge.start(), AuthError);
    expect(channel.ensures.length).toBe(1);
  });
});

describe("BridgeProtocol", () => {
  // Python: TestBridgeProtocol::test_bytes_results_are_base64 calls serialize_result directly; here the
  // bytes go through a command result (serializeResult is exported too).
  it("bytes results are base64", async () => {
    class BytesDriver extends FakeDriver {
      async dispatch(name: string, args: Args): Promise<unknown> {
        if (name === "png") return new TextEncoder().encode("abc");
        if (name === "dict") return { png: new TextEncoder().encode("abc") };
        return super.dispatch(name, args);
      }
    }
    const posts = await _serve(
      _bridge(new BytesDriver()),
      [[{ id: "c1", command_uid: "c1", name: "png", args: {} }, { id: "c2", command_uid: "c2", name: "dict", args: {} }]],
      [{ status: 200 }, { status: 200 }],
    );
    expect(posts.map((post) => post["result"])).toEqual(["YWJj", { png: "YWJj" }]);
  });

  it("driver exception becomes error", async () => {
    const posts = await _serve(_bridge(new FakeDriver()), [[{ id: "c1", command_uid: "c1", name: "boom", args: {} }]], [{ status: 200 }]);
    const { result, error } = posts[0] as { result: unknown; error: string };
    expect(result === null && error.includes("kaboom")).toBe(true);
  });

  it("each command executes once and result posted", async () => {
    const driver = new FakeDriver();
    const bridge = _bridge(driver);
    const cmd = { id: "c1", command_uid: "u1", name: "click", args: { x: 0, y: 0 } };
    const posts = await _serve(bridge, [[cmd, { ...cmd, id: "c2", command_uid: "u2" }]], [{ status: 200 }, { status: 200 }]);
    expect(driver.clicks).toBe(2);
    expect(posts.map((p) => p["command_uid"])).toEqual(["u1", "u2"]);
  });

  it("redelivered uid reposts cached result without reexecuting", async () => {
    const driver = new FakeDriver();
    const bridge = _bridge(driver);
    const cmd = { id: "c1", command_uid: "u1", name: "click", args: { x: 0, y: 0 } };
    const posts = await _serve(bridge, [[cmd], [{ ...cmd, id: "c1-retry" }]], [{ status: 200 }, { status: 200 }]);
    expect(driver.clicks).toBe(1);
    expect(posts.map((p) => p["command_uid"])).toEqual(["u1", "u1"]);
  });

  // Python: TestBridgeProtocol::test_undeliverable_result_raises_after_retries awaits _deliver with
  // POST_RESULT_RETRIES patched to 1 and sees it raise. The TS constant stays 2, and the raise is seen
  // where Python's poll loop sees it: a 502 is transient there, so the loop logs it and backs off
  // (its 4xx case, "permanent 4xx in poll loop propagates", is the one that ends serving).
  it("undeliverable result raises after retries", async () => {
    const logs: string[] = [];
    const bridge = _bridge(new FakeDriver(), (message) => logs.push(message));
    channel.batches = [[_click("c1")]];
    channel.post_replies = Array(10).fill({ status: 502 });
    await bridge.start();
    const deadline = Date.now() + 8_000;
    while (!logs.some((line) => line.startsWith("connection error")) && Date.now() < deadline) {
      await sleep(20);
    }
    await bridge.stop();
    expect(channel.posts.length).toBe(3); // POST_RESULT_RETRIES + 1
    expect(logs.at(-1)).toMatch(/^connection error: .*502.*; retrying in 1s$/);
  });

  it("auth error mid poll propagates", async () => {
    const bridge = _bridge(new FakeDriver());
    channel.command_replies = [{ status: 401 }]; // AuthError("key revoked")
    await pollLoopRaises(bridge, AuthError);
  });

  // Python: TestBridgeProtocol::test_channel_recreation_backs_off_on_rate_limit.
  it("channel recreation backs off on rate limit", async () => {
    // A 429 while recreating a lost channel must back off and retry, not kill the bridge.
    const bridge = _bridge(new FakeDriver());
    channel.command_replies = [{ status: 404 }]; // SessionNotFoundError("channel gone")
    channel.channel_replies = [{ status: 200 }, { status: 429, headers: { "Retry-After": "0" } }, { status: 200 }]; // start, then RateLimitedError, then ok
    await bridge.start();
    const deadline = Date.now() + 4_000;
    while (channel.ensures.length < 3 && Date.now() < deadline) {
      await sleep(20);
    }
    await bridge.stop();
    expect(channel.ensures.slice(1)).toEqual([bridge.sessionId, bridge.sessionId]);
  });

  // Python: TestBridgeProtocol::test_permanent_4xx_in_poll_loop_propagates.
  it("permanent 4xx in poll loop propagates", async () => {
    const bridge = _bridge(new FakeDriver());
    channel.command_replies = [{ status: 400 }]; // HTTPStatusError("bad request")
    await pollLoopRaises(bridge, Error, 3_000);
  });

  it("post result auth failure propagates", async () => {
    const bridge = _bridge(new FakeDriver());
    channel.batches = [[{ id: "c1", command_uid: "u1", name: "click", args: { x: 0, y: 0 } }]];
    channel.post_replies = [{ status: 401 }]; // AuthError("key revoked")
    await pollLoopRaises(bridge, AuthError);
  });

  it("result post 404 drops that result and keeps serving", async () => {
    const posts = await _serve(_bridge(new FakeDriver()), [[_click("c1")], [_click("c2")]], [{ status: 404 }, { status: 200 }]);
    expect(posts.map((post) => post["id"])).toEqual(["c1", "c2"]);
  });

  // Python: TestBridgeProtocol::test_result_post_429_waits_retry_after_then_lands; Python records the
  // sleep it was asked for, TS has no sleep hook, so the wait is measured on the clock.
  it.each([
    ["3", 3.0],
    ["0", 1.0],
  ])("result post 429 waits retry after then lands [%s]", async (retry_after, waited) => {
    const bridge = _bridge(new FakeDriver());
    const started = Date.now();
    const posts = await _serve(bridge, [[_click("c1")]], [{ status: 429, headers: { "Retry-After": retry_after } }, { status: 200 }]);
    expect(posts.map((post) => post["id"])).toEqual(["c1", "c1"]);
    expect((Date.now() - started) / 1000).toBeGreaterThanOrEqual(waited);
  });

  // Python: TestBridgeProtocol::test_unserializable_result_is_answered_with_an_error_and_serving_goes_on.
  // JSON.stringify turns a class instance into {}, so the TS unserialisable value is a class instance with a cycle.
  it("unserializable result is answered with an error and serving goes on", async () => {
    class WebElement {
      self: WebElement = this;
    }

    class ElementDriver extends FakeDriver {
      async dispatch(name: string, args: Args): Promise<unknown> {
        if (name === "execute_script") return { element: new WebElement() };
        return super.dispatch(name, args);
      }
    }

    const script = { id: "c1", command_uid: "c1", name: "execute_script", args: { script: "return el;" } };
    const posts = await _serve(_bridge(new ElementDriver()), [[script, _click("c2")]], [{ status: 200 }, { status: 200 }], 3_000);
    expect(posts.map((post) => [post["id"], post["error"]])).toEqual([
      ["c1", expect.stringContaining("not JSON-serializable")],
      ["c2", null],
    ]);
  });
});
