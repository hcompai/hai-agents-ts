/**
 * test_local.py: TestLocalizeAgent, TestAutoStart, TestManager and the module-level stop tests
 * (the auto-bridge half; the bridge protocol half is local_bridge.test.ts). Web only: every test
 * that spawns a desktop or workstation bridge is adapted to the browser bridge or dropped (PORT.md).
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsClient, Client, EnvironmentsClient, HaiAgentsError, SessionsClient } from "hai-agents";
import { AuthError, BridgeManager, LocalBridge, PlaywrightBrowserBridge, localizeAgent } from "hai-agents/local";
import type { AgentLike, LocalSessionsClient, ManagedBridge, Resolved } from "hai-agents/local";
import * as core from "hai-agents-src/client/core/index.js";
import { READY_TIMEOUT_S, STOP_JOIN_TIMEOUT_S, TimeoutError, _Runner, _defaultManager } from "hai-agents-src/local/manager.js";
import { DEFAULT_LOCAL_MAX_STEPS, DEFAULT_LOCAL_MAX_TIME_S, _cancelSessionsAtExit, _exitCancels, _localize } from "hai-agents-src/local/sessions.js";

import { mp, raises, raisesAsync, sleep } from "./helpers";

// hai_agents.core.api_error.ApiError
const ApiError = HaiAgentsError;
type Args = Record<string, unknown>;

/** What a patched generated method returns: Python's fakes return a plain value, the TS ones the HttpResponsePromise the client awaits with `.withRawResponse()`. */
function reply<T>(data: T): core.HttpResponsePromise<T> {
  return core.HttpResponsePromise.fromResult({ data, rawResponse: core.unknownRawResponse });
}
type Internals = { _ownedBridges: Map<string, string[]> };
function internals(sessions: unknown): Internals {
  return sessions as Internals;
}
/** Python reads the local sessions client off `client.sessions`; in TS that is the lazy stand-in, the loaded client sits behind it. */
async function localSessions(client: Client): Promise<LocalSessionsClient> {
  void client.sessions;
  return (await client["_localSessions"]) as LocalSessionsClient;
}

const API_KEY = "test-key";

describe("TestLocalizeAgent", () => {
  // Python's agent also carries a desktop environment, served by a second bridge; no desktop bridge in TS.
  it("unclaimed user device envs get bridges with fresh session ids", () => {
    const agent = { name: "x", environments: [{ host: "user_device" }] };
    const { agent: localized, bridges } = localizeAgent(agent, { apiKey: API_KEY });
    const envs = (localized as { environments: Record<string, unknown>[] }).environments;
    expect(bridges.map((b) => b.constructor)).toEqual([PlaywrightBrowserBridge]);
    expect(envs.map((e) => e.sessionId)).toEqual(bridges.map((b) => b.sessionId));
    expect(envs[0]!.kind).toBe("web");
    expect(agent.environments[0]).not.toHaveProperty("sessionId");
  });

  // Python: test_a_desktop_is_this_machine_and_its_mode_picks_the_bridge. A desktop is this machine in Python; TS cannot serve one.
  it("a desktop is this machine and is refused without a desktop bridge", () => {
    for (const mode of ["visual", "shell"]) {
      const agent = { name: "x", environments: [{ id: "box", kind: "desktop", mode: { type: mode } }] };
      raises(() => localizeAgent(agent, { apiKey: API_KEY }), Error, "supported kinds: ['web']");
    }
  });

  it("second unclaimed env of same kind raises", () => {
    const agent = {
      name: "orchestrator",
      environments: [{ id: "laptop", kind: "web", host: "user_device" }],
      subagents: [{ name: "child", environments: [{ id: "laptop-2", kind: "web", host: "user_device" }] }],
    };
    raises(() => localizeAgent(agent, { apiKey: API_KEY }), Error, "multiple local web");
  });

  it("claimed env does not count against the kind", () => {
    const agent = {
      name: "x",
      environments: [
        { id: "pinned", kind: "web", host: "user_device", sessionId: "served-elsewhere" },
        { id: "laptop", kind: "web", host: "user_device" },
      ],
    };
    const { agent: localized, bridges } = localizeAgent(agent, { apiKey: API_KEY });
    expect(bridges).toHaveLength(1);
    const envs = (localized as { environments: Record<string, unknown>[] }).environments;
    expect(envs[1]!.sessionId).toBe(bridges[0]!.sessionId);
  });

  it("claimed remote and string targets left alone", () => {
    const agent = {
      name: "x",
      environments: [
        { id: "remote", kind: "web" },
        { id: "pinned", kind: "web", host: "user_device", sessionId: "keep" },
      ],
      subagents: ["registered-agent"],
    };
    const { agent: localized, bridges } = localizeAgent(agent, { apiKey: API_KEY });
    expect(localized).toBe(agent);
    expect(bridges).toEqual([]);
    expect(localizeAgent("named-agent", { apiKey: API_KEY })).toEqual({ agent: "named-agent", bridges: [], overrides: {} });
  });

  // Python's "helper" subagent brings a shell desktop routed by a second override; here it brings a cloud browser, so only the laptop is routed.
  it("named leaves are routed by override unless claimed", () => {
    const resolved: Resolved = {
      "environment:my-laptop": { id: "my-laptop", kind: "web", host: "user_device" },
      "agent:helper": { name: "helper", environments: [{ kind: "web" }] },
      "agent:claimed": { name: "claimed", environments: [{ kind: "web", host: "user_device" }] },
    };
    const agent = {
      name: "x",
      environments: ["my-laptop", "cloud-browser", { id: "vm", kind: "workstation" }],
      subagents: ["helper", "claimed"],
    };
    const claimed = ["agent.subagents[name=claimed].environments[kind=web]"];
    const { agent: localized, bridges, overrides } = localizeAgent(agent, { apiKey: API_KEY, resolved, claimed });
    expect(localized).toEqual(agent);
    const [web] = bridges;
    expect(bridges).toHaveLength(1);
    expect(overrides).toEqual({ "agent.environments[kind=web].session_id": web!.sessionId });
  });

  // Python seeds a desktop bridge; the browser bridge is seeded the same way.
  it("seed makes bridge ids reproducible for idempotent retries", () => {
    const agent = { name: "x", environments: [{ kind: "web", host: "user_device" }] };
    const sessionId = (seed: string | undefined) => localizeAgent(agent, { apiKey: API_KEY, seed }).bridges[0]!.sessionId;
    expect(sessionId("key-1")).toBe(sessionId("key-1"));
    expect(sessionId("key-1")).not.toBe(sessionId("key-2"));
    expect(sessionId(undefined)).not.toBe(sessionId(undefined));
  });

  // Python hands _localize a stand-in client wrapper; the TS one reads the client options.
  it("seeded bridge ids are scoped to the caller", async () => {
    const sessionId = async (apiKey: string) => {
      const request = { idempotencyKey: "retry-1", body: { agent: { name: "x", environments: [{ kind: "web", host: "user_device" }] } as AgentLike as string } };
      const [bridge] = await _localize({ apiKey, baseUrl: "https://agp.test" }, undefined, request, {});
      return bridge!.sessionId;
    };
    expect(await sessionId("hk-org-a")).toBe(await sessionId("hk-org-a"));
    expect(await sessionId("hk-org-a")).not.toBe(await sessionId("hk-org-b"));
  });

  it("unaddressable named env raises", () => {
    const resolved: Resolved = { "agent:v1.2": { name: "v1.2", environments: [{ kind: "web", host: "user_device" }] } };
    raises(() => localizeAgent({ name: "x", subagents: ["v1.2"] }, { apiKey: API_KEY, resolved }), Error, "cannot be addressed");
  });

  // Python's child carries a desktop; a browser here.
  it("inline subagents are walked", () => {
    const agent: AgentLike = {
      name: "orchestrator",
      subagents: [{ name: "child", environments: [{ id: "box", kind: "web", host: "user_device" }] }],
    };
    const { agent: localized, bridges } = localizeAgent(agent, { apiKey: API_KEY });
    expect(bridges).toHaveLength(1);
    const [bridge] = bridges;
    expect(bridge).toBeInstanceOf(PlaywrightBrowserBridge);
    const subagents = (localized as { subagents: { environments: Record<string, unknown>[] }[] }).subagents;
    expect(subagents[0]!.environments[0]!.sessionId).toBe(bridge!.sessionId);
  });

  it("unsupported user device kind raises", () => {
    raises(
      () => localizeAgent({ name: "x", environments: [{ id: "phone", kind: "mobile", host: "user_device" }] }, { apiKey: API_KEY }),
      Error,
      "supported kinds",
    );
  });

  // Python builds a PyautoguiDesktopBridge in the three tests below; the browser bridge is the one TS has.
  it("bridge mints a fresh session id", () => {
    const bridge = new PlaywrightBrowserBridge({ apiKey: API_KEY, baseUrl: "http://agp.test" });
    expect(bridge.sessionId).toBeTruthy();
    expect(bridge.sessionId).not.toBe(new PlaywrightBrowserBridge({ apiKey: API_KEY, baseUrl: "http://agp.test" }).sessionId);
  });

  it("bridge without api key raises", () => {
    raises(() => new PlaywrightBrowserBridge({ apiKey: "", baseUrl: "http://agp.test" }), Error, "apiKey is required");
  });

  it("bridge rejects non uuid session id", () => {
    raises(() => new PlaywrightBrowserBridge({ apiKey: API_KEY, baseUrl: "http://agp.test", sessionId: "my-laptop-1" }), Error, "must be a UUID");
  });
});

// ---------------------------------------------------------------------------
// The manager's fakes: Python's ServingBridge / BrowserServingBridge on FakeBridge (kind "desktop";
// the manager only compares the strings, so the kinds stay Python's).
// ---------------------------------------------------------------------------

/** A bridge that is ready at once and serves until stopped. */
class ServingBridge implements ManagedBridge {
  environmentKind = "desktop";
  environmentId = "desktop";
  readonly sessionId = randomUUID();
  startupHint?: string;
  ready = false;
  onCrash: ManagedBridge["onCrash"] = null;
  done: Promise<void> = Promise.resolve();
  protected _serving: (() => void) | null = null;

  async start(): Promise<void> {
    this.done = new Promise<void>((resolve) => {
      this._serving = resolve;
    });
    this.ready = true;
  }

  async stop(): Promise<void> {
    this._serving?.();
  }
}

class BrowserServingBridge extends ServingBridge {
  override environmentKind = "web";
}

/** Python's FakeBridge, a LocalBridge with a fake driver, as the manager sees it. */
class LoopBridge implements ManagedBridge {
  environmentKind = "desktop";
  environmentId = "desktop";
  onCrash: ManagedBridge["onCrash"] = null;
  readonly #loop: LocalBridge;

  constructor(baseUrl: string) {
    this.#loop = new LocalBridge({ baseUrl, apiKey: "k", driver: { dispatch: async () => null } });
  }

  get sessionId(): string {
    return this.#loop.sessionId;
  }
  get ready(): boolean {
    return this.#loop.ready;
  }
  get done(): Promise<void> {
    return this.#loop.done;
  }
  start(): Promise<void> {
    return this.#loop.start();
  }
  stop(): Promise<void> {
    return this.#loop.stop();
  }
}

/** Python's IdleExchange (nothing to do, ever) and the 410 transport of the closed-channel test, as the routes AGP serves. */
class IdleChannel {
  readonly server: Server;
  baseUrl = "";
  /** The path suffix that answers 410, when one does. */
  closedOn: string | null = null;

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
    req.on("data", () => undefined);
    req.on("end", () => {
      if (this.closedOn !== null && path.endsWith(this.closedOn)) {
        res.writeHead(410, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      if (path.endsWith("/commands")) {
        if (this.closedOn === null) {
          res.writeHead(204).end();
          return;
        }
        const command = { id: "c1", command_uid: "u1", name: "noop", args: {} };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([command]));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  }
}

function runners(manager: BridgeManager): Map<string, _Runner> {
  return (manager as unknown as { _runners: Map<string, _Runner> })._runners;
}

/** `event.wait(timeout)` on a flag. */
async function waitFor(condition: () => boolean, timeoutS = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  while (!condition() && Date.now() < deadline) {
    await sleep(0.02);
  }
  return condition();
}

describe("TestManager", () => {
  let manager: BridgeManager;
  beforeEach(() => {
    manager = new BridgeManager();
  });
  afterEach(async () => {
    await manager.stopAll();
  });

  for (const cleanupFails of [false, true]) {
    it(`startup failure surfaces to caller without firing on crash [${cleanupFails}]`, async () => {
      let crashed = false;
      class FailingBridge extends ServingBridge {
        override async start(): Promise<void> {
          throw new AuthError("bad key");
        }
      }
      if (cleanupFails) {
        const originalStop = _Runner.prototype.stop;
        mp.setattr(_Runner.prototype, "stop", async function (this: _Runner) {
          await originalStop.call(this);
          throw new TimeoutError("cleanup also failed");
        });
      }
      const bridge = new FailingBridge();
      bridge.onCrash = () => {
        crashed = true;
      };
      const error = await raisesAsync(() => manager.ensure([bridge]), Error);
      expect(error.cause).toBeInstanceOf(AuthError);
      expect(crashed).toBe(false);
    });
  }

  it("stop during setup surfaces as startup failure", async () => {
    class StoppedDuringSetupBridge extends ServingBridge {
      override async start(): Promise<void> {
        await this.stop();
      }
    }
    await raisesAsync(() => manager.ensure([new StoppedDuringSetupBridge()]), Error, "failed to start");
    expect(runners(manager).size).toBe(0);
  });

  // Python patches READY_TIMEOUT_S down to 0.05; a module constant cannot be patched here, so the clock is faked instead.
  it("readiness timeout raises", async () => {
    class NeverReadyBridge extends ServingBridge {
      override async start(): Promise<void> {
        await new Promise<void>((resolve) => {
          this._serving = resolve;
        });
      }
    }
    vi.useFakeTimers();
    try {
      const failed = raisesAsync(() => manager.ensure([new NeverReadyBridge()]), Error, "not ready");
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_S * 1000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
    expect(runners(manager).size).toBe(0);
  });

  for (const stopTimesOut of [false, true]) {
    it(`newer session takes over the kind and notifies the displaced [${stopTimesOut}]`, async () => {
      const first = new ServingBridge();
      const second = new ServingBridge();
      const browser = new BrowserServingBridge();
      let firstLost = false;
      let secondLost = false;
      first.onCrash = () => {
        firstLost = true;
      };
      second.onCrash = () => {
        secondLost = true;
      };
      await manager.ensure([first, browser]);
      const firstRunner = runners(manager).get(first.sessionId)!;
      if (stopTimesOut) {
        const originalStop = firstRunner.stop.bind(firstRunner);
        mp.setattr(firstRunner, "stop", async () => {
          await originalStop();
          throw new TimeoutError("displaced bridge timeout");
        });
      }
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await manager.ensure([second]);
      } finally {
        errors.mockRestore();
      }
      expect(runners(manager).has(first.sessionId)).toBe(false);
      expect(firstRunner.alive).toBe(false);
      expect(firstLost).toBe(true);
      expect(secondLost).toBe(false);
      expect(runners(manager).get(second.sessionId)!.alive).toBe(true);
      expect(runners(manager).get(browser.sessionId)!.alive).toBe(true);
    });
  }

  it("ensure reports new bridges and stop is targeted", async () => {
    const bridge = new ServingBridge();
    const ids = await manager.ensure([bridge]);
    expect(ids).toEqual([bridge.sessionId]);
    expect(await manager.ensure([bridge])).toEqual([]);
    await manager.stop(ids);
    expect(runners(manager).size).toBe(0);
  });

  it("two same kind bridges in one batch raise", async () => {
    await raisesAsync(
      () => manager.ensure([new BrowserServingBridge(), new ServingBridge(), new ServingBridge()]),
      Error,
      "two local desktop",
    );
    expect(runners(manager).size).toBe(0);
  });

  describe("on a command channel", () => {
    let channel: IdleChannel;
    beforeEach(async () => {
      channel = new IdleChannel();
      await channel.start();
    });
    afterEach(async () => {
      await channel.stop();
    });

    it("restarted bridge serves again on a fresh loop", async () => {
      const bridge = new LoopBridge(channel.baseUrl);
      let crashed = false;
      bridge.onCrash = () => {
        crashed = true;
      };
      expect(await manager.ensure([bridge])).toEqual([bridge.sessionId]);
      await manager.stop([bridge.sessionId]);
      expect(await manager.ensure([bridge])).toEqual([bridge.sessionId]);
      expect(await waitFor(() => crashed, 0.5)).toBe(false);
      expect(runners(manager).get(bridge.sessionId)!.alive).toBe(true);
      await manager.stop([bridge.sessionId]);
    });

    for (const closedOn of ["/commands", "/result"]) {
      it(`closed channel is a clean stop [${closedOn}]`, async () => {
        channel.closedOn = closedOn;
        const bridge = new LoopBridge(channel.baseUrl);
        let crashed = false;
        bridge.onCrash = () => {
          crashed = true;
        };
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          await manager.ensure([bridge]);
          const runner = runners(manager).get(bridge.sessionId)!;
          expect(await waitFor(() => !runner.alive)).toBe(true);
          expect(runner.error).toBeUndefined();
          expect(crashed).toBe(false);
          expect(errors).not.toHaveBeenCalled();
        } finally {
          errors.mockRestore();
        }
      });
    }
  });

  it("crash after ready fires on crash", async () => {
    class CrashingBridge extends ServingBridge {
      override async start(): Promise<void> {
        this.ready = true;
        this.done = sleep(0.2).then(() => {
          throw new Error("boom mid-session");
        });
      }
    }
    let crashed = false;
    const bridge = new CrashingBridge();
    bridge.onCrash = () => {
      crashed = true;
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await manager.ensure([bridge]);
      expect(await waitFor(() => crashed)).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

// Python patches STOP_JOIN_TIMEOUT_S down to 0.01; the clock is faked instead.
it("manager reports unconfirmed stop and allows retry", async () => {
  class StubbornBridge extends ServingBridge {
    override async stop(): Promise<void> {}
  }
  const manager = new BridgeManager();
  const bridge = new StubbornBridge();
  await manager.ensure([bridge]);
  vi.useFakeTimers();
  try {
    const stop = raisesAsync(() => manager.stop([bridge.sessionId]), TimeoutError, "confirm stop");
    await vi.advanceTimersByTimeAsync(STOP_JOIN_TIMEOUT_S * 1000);
    await stop;
  } finally {
    vi.useRealTimers();
    bridge.stop = () => ServingBridge.prototype.stop.call(bridge);
    await manager.stop([bridge.sessionId]);
  }
  expect(runners(manager).size).toBe(0);
});

// ---------------------------------------------------------------------------
// TestAutoStart: Python patches `sessions.ensure_bridges` / `stop_bridges` / `serving_bridges`; the TS
// tests patch the process-wide manager behind them. Python's agents carry a desktop and a web
// environment; web only here, so the desktop environment is dropped from each.
// ---------------------------------------------------------------------------

/** Serve `getAgent` and `getEnvironment` from tables, 404 otherwise; returns the agent fetches. */
function _registry(agents?: Record<string, unknown>, environments?: Record<string, unknown>): [string, number | undefined][] {
  const fetched: [string, number | undefined][] = [];
  const lookup = (table: Record<string, unknown> | undefined, name: string): unknown => {
    if (!table || !(name in table)) {
      throw new ApiError({ statusCode: 404, body: { detail: "not found" } });
    }
    return table[name];
  };
  mp.setattr(AgentsClient.prototype, "getAgent", ((request: { agentName: string; revision?: number | null; resolve?: boolean }) => {
    expect(request.resolve, "only the resolved spec names its nested subagents and environments").toBe(true);
    fetched.push([request.agentName, request.revision ?? undefined]);
    return reply(lookup(agents, request.agentName));
  }) as never);
  mp.setattr(EnvironmentsClient.prototype, "getEnvironment", ((request: { id: string }) => reply(lookup(environments, request.id))) as never);
  return fetched;
}

const _create = (fake: (request: { body: Args }) => unknown) => mp.setattr(SessionsClient.prototype, "createSession", fake as never);
const _cancel = (fake: (request: { id: string }) => unknown) => mp.setattr(SessionsClient.prototype, "cancelSession", fake as never);
const _status = (fake: (request: { id: string }) => unknown) => mp.setattr(SessionsClient.prototype, "getSessionStatus", fake as never);
const _send = (fake: (request: { id: string; body: Args }) => unknown) => mp.setattr(SessionsClient.prototype, "sendSessionMessages", fake as never);
const _ensure = (fake: (bridges: readonly ManagedBridge[]) => Promise<string[]>) => mp.setattr(_defaultManager, "ensure", fake);
const _stop = (fake: (ids: readonly string[]) => Promise<void>) => mp.setattr(_defaultManager, "stop", fake);

describe("TestAutoStart", () => {
  it("create session starts bridges and stamps matching session ids", async () => {
    const started: ManagedBridge[] = [];
    let captured: { body: Args } | undefined;
    _ensure(async (bridges) => {
      started.push(...bridges);
      return [];
    });
    _create((request) => {
      captured = request;
      return reply(undefined);
    });
    await new Client({ apiKey: API_KEY }).sessions.createSession({
      body: {
        agent: {
          name: "x",
          environments: [{ id: "cloud", kind: "web" }],
          subagents: [{ name: "child", environments: [{ id: "laptop", kind: "web", host: "user_device" }] }],
        } as AgentLike as string,
        messages: "hi",
      },
    });
    const [web] = started;
    expect(started).toHaveLength(1);
    expect(web).toBeInstanceOf(PlaywrightBrowserBridge);
    const agent = captured!.body.agent as { subagents: { environments: Args[] }[] };
    expect(agent.subagents[0]!.environments[0]!.sessionId).toBe(web!.sessionId);
  });

  it("named agent routes its user device env through an override", async () => {
    const started: ManagedBridge[] = [];
    let captured: { body: Args } | undefined;
    const fetched = _registry({
      "my-agent": { name: "my-agent", description: "", environments: [{ kind: "web", id: "box", host: "user_device" }] },
    });
    _ensure(async (bridges) => {
      started.push(...bridges);
      return [];
    });
    _create((request) => {
      captured = request;
      return reply(undefined);
    });
    await new Client({ apiKey: API_KEY }).sessions.createSession({
      body: { agent: "my-agent:3", messages: "hi", overrides: { "agent.model": "m" } },
    });
    const [bridge] = started;
    expect(started).toHaveLength(1);
    expect(bridge).toBeInstanceOf(PlaywrightBrowserBridge);
    expect(fetched).toEqual([["my-agent", 3]]);
    expect(captured!.body.agent).toBe("my-agent:3");
    expect(captured!.body.overrides).toEqual({
      "agent.environments[kind=web].session_id": bridge!.sessionId,
      "agent.model": "m",
    });
  });

  for (const stop of ["ended", "cancelled"]) {
    it(`follow up to a stopped session serves its bridges again [${stop}]`, async () => {
        _exitCancels.clear();
      const events: unknown[] = [];
      _ensure(async (bridges) => {
        events.push(["start", bridges.map((bridge) => bridge.environmentKind)]);
        return bridges.map((bridge) => bridge.sessionId);
      });
      _stop(async () => {
        events.push("stop");
      });
      _create(() => reply({ id: "sess-1" }));
      _status(() => reply({ status: "completed" }));
      const failures = [new Error("network down")];
      _send(() => {
        const failure = failures.shift();
        if (failure) {
          throw failure;
        }
        events.push("send");
        return reply(undefined);
      });
      _cancel(() => reply(undefined));
      const sessions = new Client({ apiKey: API_KEY }).sessions;
      await sessions.createSession({
        body: { agent: { name: "x", environments: [{ kind: "web", host: "user_device" }] } as AgentLike as string, messages: "hi" },
      });
      if (stop === "ended") {
        await sessions.getSessionStatus({ id: "sess-1" });
      } else {
        await sessions.cancelSession({ id: "sess-1" });
      }
      const more = { type: "user_message", message: "more" } as const;
      await raisesAsync(() => sessions.sendSessionMessages({ id: "sess-1", body: more }), Error);
      await sessions.sendSessionMessages({ id: "sess-1", body: more });
      await sessions.sendSessionMessages({ id: "sess-1", body: { type: "user_message", message: "again" } });

      const restart = ["start", ["web"]];
      expect(events).toEqual([restart, "stop", restart, "stop", restart, "send", "send"]);
      expect([..._exitCancels.keys()]).toEqual(["sess-1"]);
    });
  }

  it("create session failure stops newly started bridges", async () => {
    const stopped: string[] = [];
    _ensure(async () => ["new-sid"]);
    _stop(async (ids) => {
      stopped.push(...ids);
      throw new TimeoutError("bridge did not stop");
    });
    _create(() => {
      throw new Error("api down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await raisesAsync(
        () =>
          new Client({ apiKey: API_KEY }).sessions.createSession({
            body: { agent: { name: "x", environments: [{ id: "box", kind: "web", host: "user_device" }] } as AgentLike as string, messages: "hi" },
          }),
        Error,
        "api down",
      );
    } finally {
      warnings.mockRestore();
    }
    expect(stopped).toEqual(["new-sid"]);
  });

  function _crashWiring(cancelled: string[], stopped: string[], bridges: ManagedBridge[]): void {
    _stop(async (ids) => {
      stopped.push(...ids);
    });
    _cancel((request) => {
      cancelled.push(request.id);
      return reply(undefined);
    });
    _ensure(async (fresh) => {
      bridges.push(...fresh);
      return fresh.map((bridge) => bridge.sessionId);
    });
  }

  // Python's agent has a desktop and a web environment: two bridges, the second a sibling of the first.
  const _TWO_ENV_AGENT = { name: "x", environments: [{ id: "laptop", kind: "web", host: "user_device" }] };
  const _twoEnvBody = () => ({ agent: { ..._TWO_ENV_AGENT } as AgentLike as string, messages: "hi" });
  const _silenced = async (run: () => Promise<void>) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await run();
    } finally {
      errors.mockRestore();
    }
  };

  it("bridge loss cancels session once and stops sibling bridges", async () => {
    const cancelled: string[] = [];
    const stopped: string[] = [];
    const bridges: ManagedBridge[] = [];
    _crashWiring(cancelled, stopped, bridges);
    _create(() => reply({ id: "sess-1" }));
    await new Client({ apiKey: API_KEY }).sessions.createSession({ body: _twoEnvBody() });
    await _silenced(() => bridges[0]!.onCrash!() as Promise<void>);
    expect(cancelled).toEqual(["sess-1"]);
    expect(stopped).toEqual(bridges.map((bridge) => bridge.sessionId));
    await _silenced(() => bridges[0]!.onCrash!() as Promise<void>);
    expect(cancelled).toEqual(["sess-1"]);
  });

  it("crash between startup and session creation still cancels", async () => {
    const cancelled: string[] = [];
    const stopped: string[] = [];
    const bridges: ManagedBridge[] = [];
    _crashWiring(cancelled, stopped, bridges);
    _create(() => {
      void bridges[0]!.onCrash!();
      return reply({ id: "sess-2" });
    });
    await _silenced(() => new Client({ apiKey: API_KEY }).sessions.createSession({ body: _twoEnvBody() }) as Promise<unknown> as Promise<void>);
    expect(cancelled).toEqual(["sess-2"]);
    expect(stopped).toEqual(bridges.map((bridge) => bridge.sessionId));
  });

  it("interpreter exit cancels sessions served by this process", async () => {
    const cancelled: string[] = [];
    const stopped: string[] = [];
    const bridges: ManagedBridge[] = [];
    _crashWiring(cancelled, stopped, bridges);
    _create(() => reply({ id: "sess-4" }));
    await new Client({ apiKey: API_KEY }).sessions.createSession({ body: _twoEnvBody() });
    await _cancelSessionsAtExit();
    expect(cancelled).toEqual(["sess-4"]);
    await _cancelSessionsAtExit();
    expect(cancelled).toEqual(["sess-4"]);
  });

  it("crash cancel deregisters the exit hook", async () => {
    const cancelled: string[] = [];
    const stopped: string[] = [];
    const bridges: ManagedBridge[] = [];
    _crashWiring(cancelled, stopped, bridges);
    _create(() => reply({ id: "sess-5" }));
    await new Client({ apiKey: API_KEY }).sessions.createSession({ body: _twoEnvBody() });
    await _silenced(() => bridges[0]!.onCrash!() as Promise<void>);
    await _cancelSessionsAtExit();
    expect(cancelled).toEqual(["sess-5"]);
  });

  it("local sessions get default runaway budgets", async () => {
    let captured: { body: Args } | undefined;
    _ensure(async () => []);
    _create((request) => {
      captured = request;
      return reply(undefined);
    });
    const client = new Client({ apiKey: API_KEY });
    await client.sessions.createSession({ body: _twoEnvBody() });
    expect(captured!.body.maxSteps).toBe(DEFAULT_LOCAL_MAX_STEPS);
    expect(captured!.body.maxTimeS).toBe(DEFAULT_LOCAL_MAX_TIME_S);
    captured = undefined;
    await client.sessions.createSession({ body: { ..._twoEnvBody(), maxSteps: null, maxTimeS: 10 } });
    expect(captured!.body.maxSteps).toBeNull();
    expect(captured!.body.maxTimeS).toBe(10);
    captured = undefined;
    _registry();
    await client.sessions.createSession({ body: { agent: "named-agent", messages: "hi" } });
    expect(captured!.body).not.toHaveProperty("maxSteps");
    expect(captured!.body).not.toHaveProperty("maxTimeS");
  });

  // Python's test flips HAI_AUTO_BRIDGE to 0; TS does not read the variable (its Python main removed it), so the option is the switch.
  it("no bridges and no stamping when disabled", async () => {
    const started: ManagedBridge[] = [];
    let captured: { body: Args } | undefined;
    _ensure(async (bridges) => {
      started.push(...bridges);
      return [];
    });
    _create((request) => {
      captured = request;
      return reply(undefined);
    });
    await new Client({ apiKey: API_KEY, autoBridges: false }).sessions.createSession({
      body: { agent: { name: "x", environments: [{ id: "box", kind: "web", host: "user_device" }] } as AgentLike as string, messages: "hi" },
    });
    expect(started).toEqual([]);
    const agent = captured!.body.agent as { environments: Args[] };
    expect(agent.environments[0]).not.toHaveProperty("sessionId");
  });
});

// ---------------------------------------------------------------------------
// The module-level stop tests. Python runs each against its sync and async clients; TS has one.
// ---------------------------------------------------------------------------

for (const [error, retriedAtExit] of [
  [new Error("remote cancel unavailable"), ["run"]],
  [new ApiError({ statusCode: 409, body: "ended" }), []],
] as const) {
  it(`exit retry outlives only an unconfirmed cancel [${error.constructor.name}]`, async () => {
    const retried: string[] = [];
    _exitCancels.clear();
    _exitCancels.set("run", async () => {
      retried.push("run");
    });
    _cancel(() => {
      throw error;
    });
    const client = new Client({ apiKey: API_KEY });
    try {
      await raisesAsync(() => client.sessions.cancelSession({ id: "run" }), error.constructor as ErrorConstructor);
      await _cancelSessionsAtExit();
      expect(retried).toEqual(retriedAtExit);
    } finally {
      await client.close();
    }
  });
}

it("close cancels only sessions still served", async () => {
  const cancelled: string[] = [];
  _exitCancels.clear();
  _exitCancels.set("ended", async () => {
    cancelled.push("ended at exit");
  });
  // httpx.MockTransport: the session id is the last path segment of the cancel.
  const respond: typeof fetch = async (input) => {
    const sessionId = new URL(String(input)).pathname.split("/").at(-1)!;
    cancelled.push(sessionId);
    return new Response(null, { status: sessionId === "evicted" ? 404 : 204 });
  };
  _stop(async () => undefined);
  mp.setattr(_defaultManager, "serving", (ids: readonly string[]) => ids.filter((id) => id !== "ended-bridge"));
  const client = new Client({ apiKey: API_KEY, baseUrl: "http://api.test", fetch: respond });
  const sessions = await localSessions(client);
  internals(sessions)._ownedBridges = new Map([
    ["live", ["live-bridge"]],
    ["ended", ["ended-bridge"]],
    ["evicted", ["evicted-bridge"]],
  ]);
  await sessions.cancelSession({ id: "unbridged" });
  await sessions.close();
  await _cancelSessionsAtExit();
  expect(cancelled).toEqual(["unbridged", "live", "evicted"]);
  expect(internals(sessions)._ownedBridges).toEqual(new Map());
});

it("cancel reaches api when local stop cannot be confirmed", async () => {
  const cancelled: string[] = [];
  _stop(async () => {
    throw new TimeoutError("local command still running");
  });
  _cancel((request) => {
    cancelled.push(request.id);
    return reply(undefined);
  });
  const sessions = await localSessions(new Client({ apiKey: API_KEY }));
  internals(sessions)._ownedBridges = new Map([["run", ["device"]]]);
  await raisesAsync(() => sessions.cancelSession({ id: "run" }), TimeoutError, "still running");
  expect(cancelled).toEqual(["run"]);
  expect(internals(sessions)._ownedBridges, "An unconfirmed stop must remain retryable").toEqual(new Map([["run", ["device"]]]));
});

it("terminal status read stops the session bridges", async () => {
  const stopped: string[] = [];
  const statuses = ["running", "completed"];
  _stop(async (ids) => {
    stopped.push(...ids);
  });
  _status(() => reply({ status: statuses.shift() }));
  const sessions = await localSessions(new Client({ apiKey: API_KEY }));
  internals(sessions)._ownedBridges = new Map([["run", ["device"]]]);
  await sessions.getSessionStatus({ id: "run" });
  expect(stopped).toEqual([]);
  await sessions.getSessionStatus({ id: "run" });
  expect(stopped).toEqual(["device"]);
  expect(internals(sessions)._ownedBridges).toEqual(new Map());
});
