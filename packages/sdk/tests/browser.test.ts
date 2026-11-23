// The ready-made browser bridge: its optional dependencies, and the composition of LocalBridge
// with the hai-drivers driver on a Chrome of this machine. hai-drivers is absent here (it is not
// in the registry) and faked per test; playwright-core is faked, so no browser is needed.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlaywrightBrowserBridge } from "../src/local/index.js";

const fakes = vi.hoisted(() => ({
  dispatched: [] as string[],
  closed: [] as string[],
  /** The contexts the fake driver was built on. */
  contexts: [] as unknown[],
  /** The options of the last launchPersistentContext. */
  launchOptions: undefined as Record<string, unknown> | undefined,
  /** Set, the fake launch waits on it. */
  launchGate: null as Promise<void> | null,
}));

const fakeHaiDrivers = () => ({
  PlaywrightWebDriver: class {
    constructor(context: unknown) {
      fakes.contexts.push(context);
    }
    async dispatch(name: string): Promise<unknown> {
      fakes.dispatched.push(name);
      return null;
    }
  },
});

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: async () => ({
      contexts: () => [{ pages: () => [{}], close: async () => fakes.closed.push("attached-context") }],
      newContext: async () => ({ pages: () => [], newPage: async () => ({}), close: async () => undefined }),
      close: async () => fakes.closed.push("cdp"),
    }),
    launchPersistentContext: async (userDataDir: string, options: Record<string, unknown>) => {
      fakes.launchOptions = options;
      await fakes.launchGate;
      return { pages: () => [{}], close: async () => fakes.closed.push(`launched:${userDataDir}`) };
    },
  },
}));

/** A command channel: queued commands go out on the next poll, results are collected. */
class FakeChannel {
  readonly server: Server;
  readonly queue: Record<string, unknown>[] = [];
  readonly results: Record<string, unknown>[] = [];
  /** Channel registrations seen (`ensureChannel`). */
  registrations = 0;
  baseUrl = "";

  constructor() {
    this.server = createServer((req, res) => this.#handle(req, res));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async wait(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.results.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", this.baseUrl).pathname;
      if (path.startsWith("/api/v1/trajectories/")) {
        this.registrations += 1;
        res.writeHead(200).end("{}");
      } else if (path.endsWith("/commands")) {
        const batch = this.queue.splice(0);
        if (batch.length === 0) res.writeHead(204).end();
        else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(batch));
      } else if (path.endsWith("/result")) {
        this.results.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200).end("{}");
      } else {
        res.writeHead(404).end();
      }
    });
  }
}

const channel = new FakeChannel();
beforeAll(() => channel.listen());
afterAll(() => channel.close());
beforeEach(() => {
  fakes.dispatched.length = 0;
  fakes.closed.length = 0;
  fakes.contexts.length = 0;
  fakes.launchOptions = undefined;
  fakes.launchGate = null;
});

/** A caller-owned Playwright context, as the bridge sees it. */
const ownContext = () => ({ pages: () => [{}], close: async () => fakes.closed.push("own-context") }) as unknown as import("playwright-core").BrowserContext;

describe("PlaywrightBrowserBridge", () => {
  it("names the optional packages when hai-drivers is not installed", async () => {
    const bridge = new PlaywrightBrowserBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test" });
    const error = await bridge.start().then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe("Local browser control requires extra deps. Install with: npm install hai-drivers playwright-core");
    expect(String((error?.cause as Error).message)).toMatch(/hai-drivers\/web\/playwright/);
  });

  it("launches Chrome on the profile, serves commands through the driver and closes it on stop", async () => {
    vi.doMock("hai-drivers/web/playwright", fakeHaiDrivers);
    const logs: string[] = [];
    const bridge = new PlaywrightBrowserBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", debuggingPort: 1, onLog: (m) => logs.push(m) });
    await bridge.start();
    channel.queue.push({ id: "c1", command_uid: "u1", name: "goto", args: { url: "https://example.com" } });
    await channel.wait(1);
    await bridge.stop();

    expect(fakes.dispatched).toEqual(["goto"]);
    expect(channel.results[0]).toMatchObject({ error: null, command_uid: "u1" });
    expect(logs[0]).toMatch(/^launching Chrome \(profile: .*chrome-profile\)$/);
    expect(fakes.closed).toEqual([expect.stringMatching(/^launched:.*chrome-profile$/)]);
    // The renderer sandbox stays on (Playwright would add --no-sandbox): the agent drives this Chrome to any site.
    expect(fakes.launchOptions).toMatchObject({ channel: "chrome", headless: false, chromiumSandbox: true });
    expect(PlaywrightBrowserBridge.environment).toEqual({ kind: "web", host: "user_device" });
  });

  it("releases a Chrome launched while stop() was requested, and reports not ready", async () => {
    vi.doMock("hai-drivers/web/playwright", fakeHaiDrivers);
    let open = () => {};
    fakes.launchGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const bridge = new PlaywrightBrowserBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", debuggingPort: 1 });
    const starting = bridge.start();
    while (fakes.launchOptions === undefined) await new Promise((r) => setTimeout(r, 5)); // Chrome is launching
    const stopping = bridge.stop();
    open();
    await starting;
    await stopping;
    expect(bridge.ready).toBe(false);
    expect(fakes.closed).toEqual([expect.stringMatching(/^launched:/)]);
  });

  it("ends its loop when the context it serves closes, so the manager cancels the session", async () => {
    let onClose: (() => void) | undefined;
    const context = {
      pages: () => [{}],
      close: async () => undefined,
      on: (event: string, listener: () => void) => {
        if (event === "close") onClose = listener;
      },
    } as unknown as import("playwright-core").BrowserContext;
    const bridge = new PlaywrightBrowserBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", context, driver: () => ({ dispatch: async () => null }) });
    await bridge.start();
    expect(onClose).toBeDefined();
    onClose!();
    await expect(bridge.done).rejects.toThrow("browser closed");
    await bridge.stop();
  });

  // ts-ahead: browser.py cannot take a Playwright context (Selenium), nor a driver factory.
  it("serves a context the caller owns through the driver the caller builds, and leaves the context open on stop", async () => {
    const context = ownContext();
    const commands: string[] = [];
    const logs: string[] = [];
    let registeredWhenBuilt = 0;
    const bridge = new PlaywrightBrowserBridge({
      baseUrl: channel.baseUrl,
      apiKey: "hk-test",
      context,
      driver: (given) => {
        expect(given).toBe(context);
        registeredWhenBuilt = channel.registrations; // the channel is open before the driver exists, as in Python's run()
        return { dispatch: async (name) => (fakes.dispatched.push(name), null) };
      },
      onCommand: (name) => commands.push(name),
      onLog: (m) => logs.push(m),
    });
    const registeredBefore = channel.registrations;
    const resultsBefore = channel.results.length;
    await bridge.start();
    channel.queue.push({ id: "c2", command_uid: "u2", name: "click", args: { x: 1, y: 2 } });
    await channel.wait(resultsBefore + 1);
    await bridge.stop();

    expect(registeredWhenBuilt).toBe(registeredBefore + 1);
    expect(fakes.dispatched).toEqual(["click"]);
    expect(commands).toEqual(["click"]);
    expect(channel.results[channel.results.length - 1]).toMatchObject({ error: null, command_uid: "u2" });
    expect(logs).toEqual([]); // no Chrome launched or attached
    expect(fakes.closed).toEqual([]); // the context is the caller's to close
  });

  it("builds the plain hai-drivers driver on a caller's context when no factory is given", async () => {
    vi.doMock("hai-drivers/web/playwright", fakeHaiDrivers);
    const context = ownContext();
    const bridge = new PlaywrightBrowserBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", context, debuggingPort: 1 });
    await bridge.start();
    await bridge.stop();
    expect(fakes.contexts).toEqual([context]);
    expect(fakes.closed).toEqual([]);
  });

  it("opens a page on a caller's context that has none, as the driver takes the first page as its tab", async () => {
    vi.doMock("hai-drivers/web/playwright", fakeHaiDrivers);
    const pages: unknown[] = [];
    const context = { pages: () => pages, newPage: async () => { pages.push({}); return {}; }, close: async () => undefined } as unknown as import("playwright-core").BrowserContext;
    const bridge = new PlaywrightBrowserBridge({ baseUrl: channel.baseUrl, apiKey: "hk-test", context, debuggingPort: 1 });
    await bridge.start();
    await bridge.stop();
    expect(pages).toHaveLength(1);
    expect(fakes.contexts).toEqual([context]);
  });
});
