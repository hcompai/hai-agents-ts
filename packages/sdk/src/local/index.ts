/**
 * `hai-agents/local`: run the agent on this machine instead of in H's cloud.
 *
 * Node.js only. It spawns the hai-agent-runtime binary, which is why it is a separate entry
 * point that the browser-safe main entry never imports: `Client.local()` on the main entry
 * loads this one on demand. The session API is the cloud client's.
 */

import { Client } from "../client/index.js";
import { Inference } from "./inference.js";
import { LocalRuntime, type LocalRuntimeOptions } from "./runtime.js";

/** The runtime configuration the SDK requires: the same agent routes AGP serves, with inline agents. */
export const SHARED_RECIPE = "shared";
export const RECIPE_ENV = "HAI_AGENT_RUNTIME_RECIPE";

export type LocalClientOptions = LocalRuntimeOptions & {
  /** A runtime you already hold, from `LocalRuntime.ensureStarted` or `LocalRuntime.attach`; no launch option may then be set. */
  runtime?: LocalRuntime;
};

/** `Client.local()` once this entry is loaded, as client.py's: the runtime, then the client bound to it. */
export async function local<T extends Client>(options: LocalClientOptions, ClientClass: new (options?: Client.Options) => T): Promise<T> {
  const { runtime, ...launch } = options;
  const [acquired, owned] = await acquireRuntime(runtime, launch);
  let client: T;
  try {
    client = new ClientClass({ baseUrl: acquired.baseUrl, apiKey: acquired.apiKey, fetch: acquired.fetch });
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
async function acquireRuntime(runtime: LocalRuntime | undefined, launch: LocalRuntimeOptions): Promise<[LocalRuntime, boolean]> {
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
function claim(runtime: LocalRuntime, inference: Inference | undefined): [LocalRuntime, boolean] {
  if (inference !== undefined && !runtime.owned && runtime.serves === undefined) {
    throw new Error("a runtime of unknown inference already listens there; stop it or set HAI_AGENT_RUNTIME_PORT to another port");
  }
  // Python also owns an attach to a runtime this process spawned earlier; no spawn registry in TS.
  return [runtime, runtime.owned];
}

/** The client needs the shared recipe, and starts the runtime with it; the shell's own recipe does not win. */
function launchOptions(launch: LocalRuntimeOptions): LocalRuntimeOptions {
  const options = { ...launch, requiredRecipe: SHARED_RECIPE, env: { [RECIPE_ENV]: SHARED_RECIPE, ...launch.env } };
  if (options.inference === undefined) {
    const inherited = (options.inheritEnv ?? true) ? process.env : {};
    options.inference = Inference.fromEnv({ ...inherited, ...options.env });
  }
  // Python merges inference.runtime_env into spawn_env here and stops inheriting; ensureStarted takes `inference` and its childEnv applies it after the key default.
  return options;
}

/** A `localClient()` client: `runtime` is its `localRuntime`, for callers written against this entry's former `Client`. */
export type LocalClient = Client & { readonly runtime: LocalRuntime };

/** @deprecated Use `Client.local()` from `hai-agents`; the runtime is `client.localRuntime`. */
export async function localClient(options?: LocalClientOptions): Promise<LocalClient> {
  const client = await Client.local(options);
  return Object.defineProperty(client, "runtime", { get: () => client.localRuntime }) as LocalClient;
}
/** @deprecated Use `Client` from `hai-agents`. */
export const LocalHaiAgentsClient = Client;
/** @deprecated Use `Client` from `hai-agents`. */
export type LocalHaiAgentsClient = Client;

export { LocalRuntime, type LocalRuntimeOptions, defaultPort } from "./runtime.js";
export { Inference } from "./inference.js";
export { ensureInstalled, installedBinary } from "./install.js";
export { PINNED_RUNTIME_VERSION, platformKey } from "./manifest.js";
export {
  BinaryIncompatibleError,
  BinaryNotFoundError,
  DownloadVerificationError,
  LocalRuntimeError,
  RuntimeStartTimeoutError,
  RuntimeUnhealthyError,
} from "./errors.js";
