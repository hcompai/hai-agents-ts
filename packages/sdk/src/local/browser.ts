// The browser bridge, as the Python SDK's `hai_agents_local/browser.py`: a LocalBridge serving
// web environments on a browser of this machine. Python attaches Selenium to a Chrome debugging
// port; hai-drivers for Node drives Playwright, so this attaches Playwright over CDP to a Chrome
// already listening on the port, or launches Google Chrome on the same dedicated profile. The
// launched Chrome lives with this process (Python's is detached and reused on the port next time).
// Cut from browser.py: `driver_interface`; the command set lives in the driver here. Python's
// CHROME_STARTUP_TIMEOUT_S (20 s, its own wait on the debug port) and its Chrome-not-found texts are
// Playwright's launch timeout and errors here.
// TS ahead of Python (`ts-ahead` in parity-exceptions.json): the `context` and `driver` options, so a
// product serves a Playwright context it owns (headless, Firefox or WebKit, a device preset) with a
// driver it hooks (hai-drivers' `tabs`, `onAction`, `beforeClick`); Selenium cannot take a Playwright
// context, so browser.py has neither. `onCommand` reaches the loop as on `LocalBridge`.
// Screenshots come from hai-drivers at CSS scale, so the brain's image is `screen_size` at any device
// scale; Python's drivers capture device pixels, the same thing on its scale-1 pods.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, chromium } from "playwright-core";
import { LocalBridge } from "./bridge.js";
import type { CommandDriver, LocalBridgeOptions } from "./bridge.js";

export const DEFAULT_DEBUG_PORT = 9222;
export const CHROME_PROFILE_DIR = join(homedir(), ".hai", "chrome-profile");
// The driver needs a viewport (hai-drivers sizes screenshots to it); Selenium reads the window's.
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

type Viewport = { width: number; height: number };

type PlaywrightCore = { chromium: typeof chromium };
// `hai-drivers` is not in the npm registry yet, so it cannot be a declared peer and its types are not imported: this is the slice the bridge uses.
type HaiDriversWebPlaywright = {
  PlaywrightWebDriver: new (context: BrowserContext, options: { viewport: Viewport }) => CommandDriver;
};

export interface PlaywrightBrowserBridgeOptions extends Omit<LocalBridgeOptions, "driver"> {
  /** The environment's catalog `id`, for the manager's messages; defaults to the kind. */
  environmentId?: string;
  /** A Chrome listening here is attached to; otherwise one is launched. Not read with `context`. */
  debuggingPort?: number;
  viewport?: Viewport;
  /** A Playwright context the caller owns (ts-ahead): served instead of a Chrome of this machine, and left open by `stop()`. */
  context?: BrowserContext;
  /** Builds the driver on the context (ts-ahead), replacing the plain `PlaywrightWebDriver`; called once the channel is open, as `createDriver`. */
  driver?: (context: BrowserContext) => CommandDriver | Promise<CommandDriver>;
}

/** Serves web environments with Playwright on a Chrome of this machine. */
export class PlaywrightBrowserBridge {
  static readonly environmentKind = "web";
  /** The environment fields a session sets, beside `sessionId`, to be served by this bridge. */
  static readonly environment = { kind: "web", host: "user_device" } as const;
  /** Appended to the manager's not-ready timeout error; names the common cause of a hung startup. */
  // Python ends with `holo local browser --debug-port <port>`; there is no CLI in TS, so the option is named.
  static readonly startupHint =
    "a stale Chrome or Chromium already holding the debug port (default 9222) is the usual cause; " +
    "quit it, or serve on another port with `debuggingPort`";
  readonly environmentKind = PlaywrightBrowserBridge.environmentKind;
  readonly startupHint = PlaywrightBrowserBridge.startupHint;
  readonly environmentId: string;
  readonly debuggingPort: number;
  /** The channel id, to stamp into the environment as `sessionId`. */
  readonly sessionId: string;
  /** Set by the sessions layer; the manager fires it once when the loop dies after startup. */
  onCrash: (() => void | Promise<void>) | null = null;
  readonly #viewport: Viewport;
  readonly #context: BrowserContext | null;
  readonly #driver: PlaywrightBrowserBridgeOptions["driver"] | null;
  readonly #onLog: (message: string) => void;
  readonly #bridge: LocalBridge;
  /** What `stop()` closes: the launched context (its browser goes with it) or the CDP connection; nothing for a caller's context. */
  #browser: { close(): Promise<void> } | null = null;

  constructor(options: PlaywrightBrowserBridgeOptions) {
    const { environmentId, debuggingPort = DEFAULT_DEBUG_PORT, viewport = DEFAULT_VIEWPORT, context = null, driver = null, ...bridge } = options;
    this.environmentId = environmentId || this.environmentKind;
    this.debuggingPort = debuggingPort;
    this.#viewport = viewport;
    this.#context = context;
    this.#driver = driver;
    this.#onLog = options.onLog ?? (() => {});
    // Python's create_driver: the loop builds the driver once the channel is open, and dispatches to it.
    this.#bridge = new LocalBridge({ ...bridge, driver: () => this.createDriver() });
    this.sessionId = this.#bridge.sessionId;
  }

  /** Register the channel, attach or launch the browser, then serve until `stop()` or the session ends. */
  async start(): Promise<void> {
    try {
      await this.#bridge.start();
    } catch (error) {
      await this.#release();
      throw error;
    }
    void this.#bridge.done.catch(() => undefined).finally(() => this.#release()); // Python's `_serve` finally: the driver goes with the loop
  }

  /** Stop serving and release the browser. Idempotent. */
  async stop(): Promise<void> {
    await this.#bridge.stop();
    await this.#release();
  }

  /** Rejects if the loop died (rejected key, permanent 4xx); resolves when it stops. */
  get done(): Promise<void> {
    return this.#bridge.done;
  }

  /** True once the browser is up and the channel registered. */
  get ready(): boolean {
    return this.#bridge.ready;
  }

  /** False on a caller's context (ts-ahead): the manager serves it beside other sessions' bridges instead of one web bridge per process. */
  get exclusive(): boolean {
    return this.#context === null;
  }

  /** Build the driver this bridge dispatches commands to: the caller's factory, or hai-drivers' driver on the viewport. */
  async createDriver(): Promise<CommandDriver> {
    const build = this.#driver ?? (await this.#defaultDriver());
    const context = this.#context ?? (await this.#ensureLocalChrome());
    if (context.pages().length === 0) {
      await context.newPage(); // the driver takes the first page as its tab; Python's Selenium attaches to the current one
    }
    return build(context);
  }

  async #defaultDriver(): Promise<NonNullable<PlaywrightBrowserBridgeOptions["driver"]>> {
    const { PlaywrightWebDriver } = await importOptional<HaiDriversWebPlaywright>("hai-drivers/web/playwright");
    return (context) => new PlaywrightWebDriver(context, { viewport: this.#viewport });
  }

  /** Attach to a Chrome already listening on the debugging port, or launch one with a dedicated profile. */
  async #ensureLocalChrome(): Promise<BrowserContext> {
    const { chromium } = await importOptional<PlaywrightCore>("playwright-core");
    const port = this.debuggingPort;
    if (await debuggerListening(port)) {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      this.#browser = browser; // close() disconnects; the user's Chrome stays
      return browser.contexts()[0] ?? (await browser.newContext({ viewport: this.#viewport }));
    }
    mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
    this.#onLog(`launching Chrome (profile: ${CHROME_PROFILE_DIR})`);
    // `channel: "chrome"` is Python's search of the fixed Chrome install locations; Playwright finds the binary and waits for it.
    const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, { channel: "chrome", headless: false, viewport: this.#viewport });
    this.#browser = context;
    return context;
  }

  async #release(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    try {
      await browser?.close();
    } catch (error) {
      this.#onLog(`driver teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Runtime import, as browser.py's: hai-drivers and playwright-core are absent unless installed beside the SDK. */
async function importOptional<T>(name: string): Promise<T> {
  try {
    // A variable specifier: a literal one would make tsc and bundlers look for the optional package.
    return (await import(/* @vite-ignore */ name)) as T;
  } catch (error) {
    throw new Error("Local browser control requires extra deps. Install with: npm install hai-drivers playwright-core", { cause: error });
  }
}

async function debuggerListening(port: number): Promise<boolean> {
  try {
    // Node's fetch ignores the proxy environment, as Python's trust_env=False asks.
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return response.status === 200;
  } catch {
    return false;
  }
}
