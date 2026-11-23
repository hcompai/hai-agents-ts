/**
 * `hai-agents/local`: run the agent on this machine instead of in H's cloud, or serve its browser
 * from this machine.
 *
 * Node.js only. It spawns the hai-agent-runtime binary and launches Playwright, which is why it is a
 * separate entry point that the browser-safe main entry never imports: `Client.local()` and the
 * `sessions` of the main entry's `Client` load this one on demand. The session API is the cloud
 * client's.
 *
 * Python's one `Client` auto-starts bridges wherever it runs; in TS the auto-bridge layer loads
 * lazily under Node, and in a browser the client has no bridges. Under Node, `client.sessions` is
 * `LocalSessionsClient`, for a cloud brain (`new Client({ apiKey })`) and a local one
 * (`Client.local()`): it starts a `PlaywrightBrowserBridge` for each `user_device` environment of a
 * session and stops it when the session ends. `LocalBridge` composed with a driver from
 * `hai-drivers` is the hand-built bridge.
 */

import { Client } from "../client/index.js";
import type { Inference } from "./inference.js";
import { LocalRuntime, type LocalRuntimeOptions } from "./runtime.js";
import { LocalSessionsClient } from "./sessions.js";
// The main entry types this entry through types.ts (no Node or Playwright type in it); `LocalRuntimeSurface` is the class's public surface.
import type { LocalClientOptions, LocalEntry, LocalRuntime as LocalRuntimeSurface } from "./types.js";

/** The runtime configuration the SDK requires: the same agent routes AGP serves, with inline agents. */
export const SHARED_RECIPE = "shared";
export const RECIPE_ENV = "HAI_AGENT_RUNTIME_RECIPE";

/** `Client.local()` once this entry is loaded, as client.py's: the runtime, then the client bound to it. */
export async function local<T extends Client>(options: LocalClientOptions, ClientClass: new (options?: Client.Options) => T): Promise<T> {
  const { runtime, autoBridges, ...launch } = options;
  const [acquired, owned] = await acquireRuntime(runtime, launch);
  let client: T;
  try {
    client = new ClientClass({ baseUrl: acquired.baseUrl, apiKey: acquired.apiKey, fetch: acquired.fetch, autoBridges });
  } catch (error) {
    if (owned) {
      await acquired.shutdown();
    }
    throw error;
  }
  client._hold = { runtime: acquired, owned };
  return client;
}

/** The runtime a local client talks to, and whether this process owns (and so stops) it, as acquire.py's acquire_runtime. */
async function acquireRuntime(runtime: LocalRuntimeSurface | undefined, launch: LocalRuntimeOptions): Promise<[LocalRuntimeSurface, boolean]> {
  if (runtime) {
    if (Object.values(launch).some((value) => value !== undefined)) {
      throw new Error("an attached runtime owns its inference and launch configuration");
    }
    await runtime.requireRecipe(SHARED_RECIPE);
    return [runtime, false];
  }
  const started = await LocalRuntime.ensureStarted(launchOptions(launch));
  return claim(started, launch.inference);
}

/** The runtime to use and whether this process owns it, as acquire.py's _claim. */
function claim(runtime: LocalRuntimeSurface, inference: Inference | undefined): [LocalRuntimeSurface, boolean] {
  if (inference !== undefined && !runtime.owned && runtime.serves === undefined) {
    throw new Error("a runtime of unknown inference already listens there; stop it or set HAI_AGENT_RUNTIME_PORT to another port");
  }
  // Python also owns an attach to a runtime this process spawned earlier; no spawn registry in TS.
  return [runtime, runtime.owned];
}

/** The client needs the shared recipe, and starts the runtime with it; the shell's own recipe does not win. */
function launchOptions(launch: LocalRuntimeOptions): LocalRuntimeOptions {
  // Python merges inference.runtime_env into spawn_env here and stops inheriting; ensureStarted's childEnv reads the inference the environment selects itself.
  return { ...launch, requiredRecipe: SHARED_RECIPE, env: { [RECIPE_ENV]: SHARED_RECIPE, ...launch.env } };
}

export { LocalBridge, type CommandDriver, type LocalBridgeOptions } from "./bridge.js";
export {
  localBridgeTypes,
  localizeAgent,
  references,
  splitRevision,
  type AgentLike,
  type AutoBridgeOptions,
  type AutoBridges,
  type EnvironmentLike,
  type Localized,
  type LocalizeOptions,
  type Reference,
  type Resolved,
  type WebBridgeOptions,
} from "./routing.js";
export { DEFAULT_LOCAL_MAX_STEPS, DEFAULT_LOCAL_MAX_TIME_S, REMOTE_CANCEL_TIMEOUT_S, type LocalSessionsOptions } from "./sessions.js";
export { LocalSessionsClient };
export type { BrowserContextLike, LocalClientOptions } from "./types.js";
export { BridgeManager, TimeoutError, ensureBridges, servingBridges, stopBridges, type ManagedBridge } from "./manager.js";
export { BASE_URL_ENV_VAR, DEFAULT_BASE_URL, defaultBaseUrl } from "./config.js";
export { PlaywrightBrowserBridge, CHROME_PROFILE_DIR, DEFAULT_DEBUG_PORT, type PlaywrightBrowserBridgeOptions } from "./browser.js";
export {
  AuthError,
  ChannelClosedError,
  ChannelHttpError,
  CommandExchange,
  RateLimitedError,
  SessionNotFoundError,
  serializeResult,
  type Command,
  type CommandResult,
  type FetchCommandsOptions,
  type JsonValue,
  type TransportOptions,
} from "./transport.js";
export { LocalRuntime, type LocalRuntimeOptions, defaultPort } from "./runtime.js";

// What the main entry calls on this entry once loaded; a drift here fails to compile instead of at the first call.
({ LocalSessionsClient, local }) satisfies LocalEntry;
export { Inference } from "./inference.js";
export { installedBinary } from "./install.js";
export { PINNED_RUNTIME_VERSION, platformKey } from "./manifest.js";
export {
  BinaryIncompatibleError,
  BinaryNotFoundError,
  DownloadVerificationError,
  LocalRuntimeError,
  RuntimeStartTimeoutError,
  RuntimeUnhealthyError,
} from "./errors.js";
