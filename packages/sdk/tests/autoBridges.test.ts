// TS ahead of Python (ts-ahead in the drift ledger): `autoBridges` as an object carries a product's
// per-environment bridge options (a caller's Playwright context, a driver factory, onCommand) into the
// auto path, and the manager serves N context-owning web bridges at once where Python's rule is one
// web bridge per process (one shared Chrome). Python's auto_bridges is a bool; no mirror test.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";

import { Client, SessionsClient } from "../src/index.js";
import { HttpResponsePromise, unknownRawResponse } from "../src/client/core/index.js";
import { BridgeManager, PlaywrightBrowserBridge, localizeAgent } from "../src/local/index.js";
import type { EnvironmentLike, ManagedBridge } from "../src/local/index.js";
import { _defaultManager } from "../src/local/manager.js";

const context = () => ({ pages: () => [{}] }) as unknown as BrowserContext;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("autoBridges with a product's options", () => {
  it("builds each bridge with the product's options for its environment, the walk's transport and ids winning", () => {
    const seen: EnvironmentLike[] = [];
    const laptop = { id: "laptop", kind: "web", host: "user_device" };
    const { bridges } = localizeAgent(
      { name: "qa", environments: [laptop] },
      {
        apiKey: "hk-test",
        baseUrl: "https://agp.test",
        bridgeOptions: {
          web: (environment) => {
            seen.push(environment);
            return { context: context(), debuggingPort: 4444, apiKey: "ignored", sessionId: "ignored" } as never;
          },
        },
      },
    );
    expect(seen).toEqual([laptop]);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.debuggingPort).toBe(4444);
    expect(bridges[0]!.environmentId).toBe("laptop");
    expect(bridges[0]!.exclusive).toBe(false); // it owns a context: served beside other sessions' bridges
    expect(bridges[0]!.sessionId).not.toBe("ignored");
  });

  it("reaches the auto path from the client's option", async () => {
    const started: ManagedBridge[] = [];
    vi.spyOn(_defaultManager, "ensure").mockImplementation(async (bridges) => {
      started.push(...bridges);
      return [];
    });
    vi.spyOn(SessionsClient.prototype, "createSession").mockImplementation((() => HttpResponsePromise.fromResult({ data: { id: "s1" }, rawResponse: unknownRawResponse })) as never);
    const client = new Client({ apiKey: "hk-test", autoBridges: { web: () => ({ context: context() }) } });
    await client.sessions.createSession({ body: { agent: { name: "qa", environments: [{ id: "laptop", kind: "web", host: "user_device" }] } as never, messages: "hi" } });
    expect(started).toHaveLength(1);
    expect(started[0]).toBeInstanceOf(PlaywrightBrowserBridge);
    expect(started[0]!.exclusive).toBe(false);
  });

  it("without a context the auto path keeps Python's one shared Chrome", () => {
    const { bridges } = localizeAgent({ name: "qa", environments: [{ kind: "web", host: "user_device" }] }, { apiKey: "hk-test", bridgeOptions: { web: () => ({ debuggingPort: 9333 }) } });
    expect(bridges[0]!.exclusive).toBe(true);
    expect(bridges[0]!.debuggingPort).toBe(9333);
  });
});

/** A ready-at-once bridge, Python's ServingBridge, with the exclusivity under test. */
class Fake implements ManagedBridge {
  static next = 0;
  readonly environmentKind = "web";
  readonly environmentId = "web";
  readonly sessionId = `00000000-0000-4000-8000-${String(++Fake.next).padStart(12, "0")}`;
  ready = false;
  onCrash: ManagedBridge["onCrash"] = null;
  done: Promise<void> = Promise.resolve();
  #serving: (() => void) | null = null;
  constructor(readonly exclusive: boolean | undefined) {}
  async start(): Promise<void> {
    this.done = new Promise<void>((resolve) => {
      this.#serving = resolve;
    });
    this.ready = true;
  }
  async stop(): Promise<void> {
    this.#serving?.();
  }
}

describe("BridgeManager displacing the shared-Chrome bridge", () => {
  /** A bridge that records its start and stop; `done` settles when it is stopped. */
  function recording(sessionId: string, events: string[]): ManagedBridge {
    let ready = false;
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      environmentKind: "web",
      environmentId: "laptop",
      sessionId,
      onCrash: null,
      get ready() {
        return ready;
      },
      async start() {
        events.push(`${sessionId}.start`);
        ready = true;
      },
      async stop() {
        events.push(`${sessionId}.stop`);
        finish();
      },
      done,
    };
  }

  // Two Chromes cannot share the one profile: the displaced bridge is stopped before the new one starts.
  it("stops the displaced bridge before starting the one that takes the kind over", async () => {
    const events: string[] = [];
    const manager = new BridgeManager();
    await manager.ensure([recording("a", events)]);
    await manager.ensure([recording("b", events)]);
    expect(events).toEqual(["a.start", "a.stop", "b.start"]);
    await manager.stopAll();
  });

  // Python's manager lock: the stop of the displaced bridge is awaited, so two ensure() calls for one session must not both start it.
  it("starts a bridge once when two callers ensure it at the same time", async () => {
    const events: string[] = [];
    const manager = new BridgeManager();
    await manager.ensure([recording("a", events)]);
    const b = recording("b", events);
    await Promise.all([manager.ensure([b]), manager.ensure([b])]);
    expect(events).toEqual(["a.start", "a.stop", "b.start"]);
    await manager.stopAll();
  });
});

describe("localizeAgent with kinds this machine does not serve", () => {
  it("leaves a desktop that already carries a sessionId alone, and names the way out when it must refuse one", () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const box = { id: "box", kind: "desktop", host: "user_device", sessionId };
    const { agent, bridges } = localizeAgent({ name: "qa", environments: [box] }, { apiKey: "hk-test", baseUrl: "https://agp.test" });
    expect(agent).toEqual({ name: "qa", environments: [box] });
    expect(bridges).toEqual([]);
    expect(() => localizeAgent({ name: "qa", environments: [{ id: "box", kind: "desktop", host: "user_device" }] }, { apiKey: "hk-test", baseUrl: "https://agp.test" })).toThrow(
      /kind 'desktop', which cannot be served by a local bridge; supported kinds: \['web'\]\. Give it a sessionId and serve it yourself, or start the client with autoBridges: false/,
    );
  });
});

describe("BridgeManager with context-owning bridges", () => {
  it("serves several non-exclusive web bridges at once, beside the one shared-Chrome bridge", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = new BridgeManager();
    const [a, b, c, d] = [new Fake(false), new Fake(false), new Fake(undefined), new Fake(true)];
    try {
      await manager.ensure([a]);
      await manager.ensure([b]);
      await manager.ensure([c]); // the machine's Chrome: Python's rule applies among exclusive bridges only
      expect(manager.serving([a.sessionId, b.sessionId, c.sessionId])).toEqual([a.sessionId, b.sessionId, c.sessionId]);
      expect(warn).not.toHaveBeenCalled();
      await manager.ensure([d]); // takes the Chrome over from c, and nothing else
      expect(manager.serving([a.sessionId, b.sessionId, c.sessionId, d.sessionId])).toEqual([a.sessionId, b.sessionId, d.sessionId]);
      expect(warn).toHaveBeenCalledTimes(1);
      // One batch may hold several non-exclusive web bridges; Python's duplicate-kind error stays for the exclusive ones.
      expect(await manager.ensure([new Fake(false), new Fake(false)])).toHaveLength(2);
      expect(manager.serving([d.sessionId])).toEqual([d.sessionId]); // a bridge on its own browser takes nothing over, the Chrome's included
      expect(warn).toHaveBeenCalledTimes(1);
      await expect(manager.ensure([new Fake(true), new Fake(true)])).rejects.toThrow("cannot serve two local web environments from one machine");
    } finally {
      await manager.stopAll();
    }
  });
});
