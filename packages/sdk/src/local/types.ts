// What the main entry (client/oo.ts) types the local layer with, as client.py's TYPE_CHECKING import of
// hai_agents_local: Python imports the real classes; this module imports neither Node nor Playwright, so the
// browser-safe main entry's typings stay free of both (local.d.ts carries playwright-core and
// node:child_process). The local modules take their option types from here and keep the classes.

import type { Client, HaiAgents, SessionsClient } from "../client/index.js";
import type { Inference } from "./inference.js";

export interface CommandDriver {
  /** Run one command; a thrown error becomes the command's error string. */
  dispatch(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** What the browser bridge needs of a Playwright `BrowserContext`, structurally: a real one fits, and no Playwright type reaches the main entry. */
export interface BrowserContextLike {
  pages(): unknown[];
  newPage(): Promise<unknown>;
  close(): Promise<void>;
  /** Playwright's `close` event; a bridge ends its loop when the context it serves closes. */
  on?(event: "close", listener: (context: unknown) => void): unknown;
}

export type EnvironmentLike = string | HaiAgents.Environment | Record<string, unknown>;

/** What a product adds to an auto-started web bridge (ts-ahead); the transport, the session id and the environment id are the walk's. */
export interface WebBridgeOptions {
  /** A Chrome listening here is attached to; otherwise one is launched. Not read with `context`. */
  debuggingPort?: number;
  viewport?: { width: number; height: number };
  /** A Playwright context the caller owns (ts-ahead): served instead of a Chrome of this machine, and left open by `stop()`. */
  context?: BrowserContextLike;
  /** Builds the driver on the context (ts-ahead), replacing the plain `PlaywrightWebDriver`; called once the channel is open, as `createDriver`. */
  // A method signature, so a factory typed on Playwright's `BrowserContext` fits: the context handed over is always a real one.
  driver?(context: BrowserContextLike): CommandDriver | Promise<CommandDriver>;
  /** Called with each command before it runs. */
  onCommand?: (name: string, args: Record<string, unknown>) => void;
  /** Python logs through `logging` with levels; here the caller filters. */
  onLog?: (message: string) => void;
}
/** Per-kind factories of those options, given the environment spec the bridge will serve (ts-ahead). */
export type AutoBridgeOptions = { web?: (environment: EnvironmentLike) => WebBridgeOptions };
/** `autoBridges`: on, off, or on with a product's options (ts-ahead; Python's `auto_bridges` is a bool). */
export type AutoBridges = boolean | AutoBridgeOptions;

export type LocalRuntimeOptions = {
  /** Fail unless the runtime reports this recipe; `Client.local()` asks for `SHARED_RECIPE`. */
  requiredRecipe?: string;
  /** Run this hai-agent-runtime executable instead of resolving one. */
  binaryPath?: string;
  /** Run this argv instead of a binary, e.g. a HAI checkout's `["python", "-m", "hai_agent_runtime"]`. */
  command?: string[];
  /** Runtime version to use from the managed install; defaults to the version this SDK pins. */
  version?: string;
  /** Where managed installs, state files and logs live; defaults to `~/.hai/agent-runtime`. */
  cacheDir?: string;
  /** Loopback port; defaults to 18795 for hosted inference and a stable derived port otherwise. */
  port?: number;
  /** Extra environment for the runtime process. */
  env?: Record<string, string>;
  /** Pass this process's environment to the runtime (default true). */
  inheritEnv?: boolean;
  /** Download the pinned release when no binary is installed (default false: nothing is fetched behind your back; Python's `download` defaults to True). */
  download?: boolean;
  /** How long to wait for a spawned runtime to become healthy (default 45 s). */
  timeoutMs?: number;
  /** Hosted inference by default; `Inference.selfHosted(url, model)` withholds the H key from the runtime. */
  inference?: Inference;
  /** The H API key the runtime uses for hosted inference; defaults to `HAI_API_KEY`. */
  apiKey?: string;
  /** Progress messages (resolve, download, spawn, attach). Warnings always go to `console.warn`. */
  log?: (message: string) => void;
};

/** The public surface of a `LocalRuntime` (runtime.ts implements it): what a client holds and the main entry's typings name. */
export interface LocalRuntime {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** Bearer token for the runtime's API. */
  readonly apiKey: string;
  /** True when this process spawned the runtime, so `shutdown()` may stop it. */
  readonly owned: boolean;
  readonly pid?: number;
  /** Version reported by `/health`. */
  readonly version?: string;
  /** Configuration reported by `/health`; the SDK needs `"shared"`. */
  readonly recipe?: string;
  /** The runtime process's stderr, when known. */
  readonly logPath?: string;
  /** What the runtime infers against: `"hosted"` or `"<url> <model>"`; unknown for older spawners. */
  readonly serves?: string;
  /** A `fetch` that rejects any response this runtime did not prove it sent. */
  readonly fetch: typeof fetch;
  /** True while the process this runtime spawned is still running. */
  readonly childAlive: boolean;
  /** Fail closed when an old binary or a differently configured daemon answers: a fresh `/health` probe. */
  requireRecipe(recipe: string | undefined): Promise<void>;
  /** Stop the runtime this process spawned: SIGTERM its process group, wait, then SIGKILL. */
  shutdown(): Promise<void>;
}

export type LocalClientOptions = LocalRuntimeOptions & {
  /** A runtime you already hold, from `LocalRuntime.ensureStarted` or `LocalRuntime.attach`; no launch option may then be set. */
  runtime?: LocalRuntime;
  /** Start a bridge on this machine for each `user_device` environment of a session (default true), with a product's options when an object. */
  autoBridges?: AutoBridges;
};

export interface LocalSessionsOptions {
  /** The runtime the sessions run on, for a client from `Client.local()`; none for H's cloud. */
  runtime?: LocalRuntime;
  /** Start a bridge here for each user_device environment (default true), with a product's options when an object. */
  autoBridges?: AutoBridges;
}

/** A `LocalSessionsClient` as the main entry calls it: the generated methods, and `close()`. */
export type LocalSessions = SessionsClient & { close(): Promise<void> };

/** What the main entry calls on `hai-agents/local` once loaded; index.ts checks the entry satisfies it. */
export interface LocalEntry {
  LocalSessionsClient: new (options: SessionsClient.Options, local?: LocalSessionsOptions) => LocalSessions;
  local<T extends Client>(options: LocalClientOptions, ClientClass: new (options?: Client.Options) => T): Promise<T>;
}
