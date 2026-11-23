/**
 * The hai-agent-runtime on this machine: find or download the binary, start it on a loopback
 * port with a fresh bearer token, or attach to one another process already started.
 *
 * Unlike the Python launcher: no startup lock, no re-acquire, no idle check, no auto bridges, no
 * stored-key fallback. The runtime exits on its own when the process that started it does. Of two
 * concurrent ensureStarted() calls on a free port, the loser's spawn fails and it then polls for the
 * winner's token until the deadline, so it attaches as under Python's lock. shutdown() stops a
 * runtime this process spawned even while another client in this process is attached to it.
 */

import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { BinaryIncompatibleError, BinaryNotFoundError, LocalRuntimeError, RuntimeUnhealthyError } from "./errors.js";
import { provenFetch } from "./identity.js";
import { API_KEY_VAR, type Env, HOSTED, Inference, servedInference } from "./inference.js";
import { DOWNLOAD_SHA256_ENV, DOWNLOAD_URL_ENV, installRuntime, installedBinary, pinnedArtifact } from "./install.js";
import { BINARY_NAME, PINNED_RUNTIME_VERSION } from "./manifest.js";
import { type Health, HEALTH_POLL_INTERVAL_MS, LOOPBACK_HOST, PROBE_TIMEOUT_MS, SPAWN_TIMEOUT_MS, type Spawned, probeHealth, responds, spawnRuntime, terminate, waitHealthy } from "./process.js";
import { DEFAULT_PORT, expandHome, inferenceFilePath, pidFilePath, readPid, readStateFile, resolveCacheDir, runtimeLogPath, tokenFilePath, unlinkIfContent, writeOwnerOnly } from "./state.js";
// The options and the public surface live in types.ts, which the main entry's typings import: no Node type in them.
import type { LocalRuntime as LocalRuntimeSurface, LocalRuntimeOptions } from "./types.js";

export type { LocalRuntimeOptions };

export const BINARY_PATH_ENV = "HAI_AGENT_LOCAL_BINARY_PATH";
export const BINARY_VERSION_ENV = "HAI_AGENT_LOCAL_BINARY_VERSION";
export const BASE_URL_ENV = "HAI_AGENT_LOCAL_BASE_URL";
export const PORT_ENV = "HAI_AGENT_RUNTIME_PORT";
export const AUTH_TOKEN_ENV = "HAI_AGENT_RUNTIME_API_TOKEN";
const INFERENCE_PORTS = 1_000;

// "[::1]" too: the WHATWG URL hostname keeps the brackets, where Python's urlsplit strips them.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

type Fields = {
  baseUrl: string;
  apiKey: string;
  owned: boolean;
  pid?: number;
  version?: string;
  recipe?: string;
  logPath?: string;
  serves?: string;
  child?: Spawned;
  stateFiles?: { token?: string; pid?: string; inference?: string };
};

export class LocalRuntime implements LocalRuntimeSurface {
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
  private readonly child?: Spawned;
  private stateFiles: { token?: string; pid?: string; inference?: string };

  constructor(fields: Fields) {
    this.baseUrl = fields.baseUrl;
    this.apiKey = fields.apiKey;
    this.owned = fields.owned;
    this.pid = fields.pid;
    this.version = fields.version;
    this.recipe = fields.recipe;
    this.logPath = fields.logPath;
    this.serves = fields.serves;
    this.child = fields.child;
    this.stateFiles = fields.stateFiles ?? {};
    this.fetch = provenFetch(fields.apiKey);
  }

  /** A reachable runtime: attached to one already running on the port, or spawned from the binary. */
  static async ensureStarted(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
    const log = options.log ?? (() => {});
    const cacheDir = resolveCacheDir(options.cacheDir);
    const env = childEnv(options);
    const served = servedInference(env);

    const override = process.env[BASE_URL_ENV]?.trim();
    if (override) {
      const attached = await attachAt(override.replace(/\/+$/, ""), cacheDir, log);
      if (!attached) {
        throw new RuntimeUnhealthyError(`${BASE_URL_ENV} is set to ${override} but /health is not answering there`);
      }
      return attached.verified(options.requiredRecipe, served);
    }

    const port = options.port ?? Number(process.env[PORT_ENV]?.trim() || defaultPort(served));
    const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
    let attached = await attachAt(baseUrl, cacheDir, log);
    if (attached) {
      return attached.verified(options.requiredRecipe, served);
    }

    if (options.command !== undefined && (options.command.length === 0 || options.binaryPath !== undefined)) {
      throw new Error("command must be nonempty and cannot be combined with binaryPath");
    }
    // Downloads can take a while: resolve first, then recheck attachment.
    const command = options.command ?? (await resolveCommand(options, cacheDir, log));
    // Python takes its startup lock here (flock, which Node lacks: see the header).
    attached = await attachAt(baseUrl, cacheDir, log);
    if (attached) {
      return attached.verified(options.requiredRecipe, served);
    }

    const explicitToken = env[AUTH_TOKEN_ENV]?.trim();
    const token = explicitToken || randomBytes(32).toString("base64url");
    const logPath = runtimeLogPath(port, cacheDir);
    const timeoutMs = options.timeoutMs ?? SPAWN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const child = spawnRuntime(command, { ...env, [PORT_ENV]: String(port), [AUTH_TOKEN_ENV]: token }, logPath, log);
    const stateFiles: Fields["stateFiles"] = {};
    let health: Health;
    try {
      health = await waitHealthy(baseUrl, token, child, timeoutMs, logPath);
      const status = await authenticatedProbe(baseUrl, token);
      if (options.requiredRecipe !== undefined && health.recipe !== options.requiredRecipe) {
        throw new BinaryIncompatibleError(recipeMessage(options.requiredRecipe));
      }
      if (status !== 200 || child.exited) {
        throw new RuntimeUnhealthyError("spawned runtime failed authenticated readiness probe");
      }
      // State files only once the child proved it owns the port, so another runtime's file is never replaced.
      if (!explicitToken) {
        stateFiles.token = writeOwnerOnly(tokenFilePath(port, cacheDir), token);
      }
      stateFiles.inference = writeOwnerOnly(inferenceFilePath(port, cacheDir), inferenceRecord(served, child.process.pid!));
      stateFiles.pid = writeOwnerOnly(pidFilePath(port, cacheDir), String(child.process.pid));
      // Python registers no exit handler: the runtime's parent watchdog stops it, and its state files stay. Node's does both, so a product that never calls close() leaves nothing behind.
      child.atExit = () => unlinkStateFiles(stateFiles, token, child.process.pid, inferenceRecord(served, child.process.pid!));
    } catch (error) {
      // Never leak the child or its state files.
      await terminate(child);
      unlinkStateFiles(stateFiles, token, child.process.pid, inferenceRecord(served, child.process.pid!));
      // Another spawner won the port meanwhile (Python's lock would have made this one wait): attach once it publishes its token.
      if (!(error instanceof BinaryIncompatibleError) && (await responds(baseUrl))) {
        const winner = await attachUntil(baseUrl, cacheDir, log, deadline);
        if (winner) {
          return winner.verified(options.requiredRecipe, served);
        }
      }
      throw error;
    }
    warnOnVersionSkew(health.version);
    log(`started hai-agent-runtime ${health.version ?? ""} on ${baseUrl} (pid ${child.process.pid})`);
    return new LocalRuntime({
      baseUrl,
      apiKey: token,
      owned: true,
      pid: child.process.pid,
      version: health.version,
      recipe: health.recipe,
      logPath,
      serves: served,
      child,
      stateFiles,
    });
  }

  /** The runtime already running on this machine, or undefined when nothing answers `/health`. */
  static async attach(options: { port?: number; cacheDir?: string; log?: (message: string) => void } = {}): Promise<LocalRuntime | undefined> {
    const cacheDir = resolveCacheDir(options.cacheDir);
    const log = options.log ?? (() => {});
    const override = process.env[BASE_URL_ENV]?.trim();
    if (override) {
      return attachAt(override.replace(/\/+$/, ""), cacheDir, log);
    }
    const port = options.port ?? Number(process.env[PORT_ENV]?.trim() || DEFAULT_PORT);
    return attachAt(`http://${LOOPBACK_HOST}:${port}`, cacheDir, log);
  }

  /** True while the process this LocalRuntime spawned is still running. */
  get childAlive(): boolean {
    return this.child !== undefined && !this.child.exited;
  }

  /** Fail closed when an old binary or a differently configured daemon answers: a fresh `/health` probe. */
  async requireRecipe(recipe: string | undefined): Promise<void> {
    if (recipe === undefined) {
      return;
    }
    const health = await probeHealth(this.baseUrl, this.apiKey);
    if (!health || health.recipe !== recipe) {
      throw new BinaryIncompatibleError(recipeMessage(recipe));
    }
  }

  /** Stop the runtime this LocalRuntime spawned: SIGTERM its process group, wait, then SIGKILL. */
  async shutdown(): Promise<void> {
    if (!this.owned || !this.child) {
      throw new LocalRuntimeError("shutdown() only stops runtimes this LocalRuntime spawned");
    }
    await terminate(this.child);
    const record = this.serves !== undefined && this.pid !== undefined ? inferenceRecord(this.serves, this.pid) : undefined;
    unlinkStateFiles(this.stateFiles, this.apiKey, this.pid, record);
    this.stateFiles = {};
  }

  /** This runtime, once it supports `recipe` and was not started for another inference than `served`. */
  private async verified(recipe: string | undefined, served: string): Promise<this> {
    await this.requireRecipe(recipe);
    if (this.serves !== undefined && this.serves !== served) {
      throw new LocalRuntimeError(
        `the runtime at ${this.baseUrl} infers against ${this.serves}, not ${served}; set ${PORT_ENV} to run another one`,
      );
    }
    return this;
  }
}

/** Hosted inference on the default port; any other inference on its own stable port, so both can run side by side. */
export function defaultPort(served: string): number {
  if (served === HOSTED) {
    return DEFAULT_PORT;
  }
  const digest = createHash("sha256").update(served).digest("hex");
  return DEFAULT_PORT + 1 + Number(BigInt(`0x${digest}`) % BigInt(INFERENCE_PORTS));
}

function recipeMessage(recipe: string): string {
  return `runtime must support recipe "${recipe}"; use a compatible source command or binary`;
}

/** The environment the runtime process starts with, before port and token are added. */
function childEnv(options: LocalRuntimeOptions): Env {
  const inherit = options.inheritEnv ?? true;
  const env: Env = { ...(inherit ? process.env : {}), ...(options.env ?? {}) };
  if (options.apiKey !== undefined) {
    env[API_KEY_VAR] = options.apiKey;
  } else if (env[API_KEY_VAR] === undefined && process.env[API_KEY_VAR]) {
    env[API_KEY_VAR] = process.env[API_KEY_VAR];
  }
  // The inference the environment selects withholds the H key too, as Python's spawn_env does.
  const inference = options.inference ?? Inference.fromEnv(env);
  return inference ? inference.runtimeEnv(env) : env;
}

/** Explicit path > HAI_AGENT_LOCAL_BINARY_PATH > PATH > managed install > verified download (opt-in). */
async function resolveCommand(options: LocalRuntimeOptions, cacheDir: string, log: (m: string) => void): Promise<string[]> {
  const explicit = options.binaryPath ?? process.env[BINARY_PATH_ENV]?.trim();
  if (explicit) {
    const candidate = expandHome(explicit);
    if (!isFile(candidate)) {
      throw new BinaryNotFoundError(`binaryPath / ${BINARY_PATH_ENV} points at a missing file: ${candidate}`);
    }
    return [candidate];
  }
  const onPath = findOnPath(BINARY_NAME);
  if (onPath) {
    log(`resolved hai-agent-runtime from PATH: ${onPath}`);
    return [onPath];
  }
  const version = options.version || process.env[BINARY_VERSION_ENV]?.trim() || PINNED_RUNTIME_VERSION;
  const managed = installedBinary(version, cacheDir);
  if (managed) {
    log(`resolved hai-agent-runtime from managed install v${version}: ${managed}`);
    return [managed];
  }
  if (!options.download) {
    throw new BinaryNotFoundError(
      `hai-agent-runtime not found: not on PATH, no managed install under ${join(cacheDir, "bin")}, and download is off. ` +
        `Pass binaryPath, set ${BINARY_PATH_ENV}, or allow { download: true }.`,
    );
  }
  if (version !== PINNED_RUNTIME_VERSION && !process.env[DOWNLOAD_URL_ENV]?.trim()) {
    throw new BinaryIncompatibleError(
      `cannot download hai-agent-runtime ${version}: this SDK pins sha256 digests for ${PINNED_RUNTIME_VERSION} only. ` +
        `Install ${version} yourself, or set ${DOWNLOAD_URL_ENV} + ${DOWNLOAD_SHA256_ENV} to a trusted build.`,
    );
  }
  log(`downloading hai-agent-runtime ${version}`);
  const installed = await installRuntime(pinnedArtifact(), version, cacheDir);
  log(`installed hai-agent-runtime ${version} at ${installed}`);
  return [installed];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** shutil.which: the first executable file of that name on PATH (Windows checks PATHEXT too; here the bare name only). */
function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (isFile(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Status of a proven, bearer-authenticated session listing; call only after `/health` proved the server. */
async function authenticatedProbe(baseUrl: string, token: string): Promise<number> {
  const response = await provenFetch(token)(`${baseUrl}/api/v2/sessions?size=1`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return response.status;
}

async function attachAt(baseUrl: string, cacheDir: string, log: (m: string) => void): Promise<LocalRuntime | undefined> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username) {
    throw new LocalRuntimeError("local runtime attachment requires a loopback HTTP URL");
  }
  const port = Number(url.port) || DEFAULT_PORT;
  const tokenFile = tokenFilePath(port, cacheDir);
  const token = process.env[AUTH_TOKEN_ENV]?.trim() || readStateFile(tokenFile);
  if (!token) {
    if (!(await responds(baseUrl))) {
      return undefined;
    }
    throw new LocalRuntimeError(
      `an agent runtime is answering at ${baseUrl} but no credentials were found: ${AUTH_TOKEN_ENV} is not set and ` +
        `${tokenFile} does not exist, so this client cannot authenticate. Export the token or stop that runtime.`,
    );
  }
  const health = await probeHealth(baseUrl, token);
  if (!health) {
    return undefined;
  }
  let status: number;
  try {
    status = await authenticatedProbe(baseUrl, token);
  } catch (error) {
    if (error instanceof LocalRuntimeError) {
      throw error;
    }
    throw new LocalRuntimeError("runtime attachment failed authenticated session probe", { cause: error });
  }
  if (status !== 200) {
    throw new LocalRuntimeError("runtime attachment failed authenticated session probe");
  }
  warnOnVersionSkew(health.version);
  const pid = readPid(port, cacheDir);
  log(`attached to the agent runtime another process started on ${baseUrl} (pid ${pid ?? "unknown"})`);
  const logPath = runtimeLogPath(port, cacheDir);
  return new LocalRuntime({
    baseUrl,
    apiKey: token,
    owned: false,
    pid,
    version: health.version,
    recipe: health.recipe,
    logPath: existsSync(logPath) ? logPath : undefined,
    // A Python spawner on Windows writes the record in text mode, with CRLF.
    serves: readStateFile(inferenceFilePath(port, cacheDir))?.split(/\r?\n/)[0]?.trim(),
  });
}

/**
 * `attachAt`, retried until `deadline` while the runtime on the port has not published its token yet: the wait
 * Python's startup lock gives a spawner that lost the port to a concurrent one.
 */
async function attachUntil(baseUrl: string, cacheDir: string, log: (m: string) => void, deadline: number): Promise<LocalRuntime | undefined> {
  for (;;) {
    try {
      const attached = await attachAt(baseUrl, cacheDir, log);
      if (attached) {
        return attached;
      }
    } catch (error) {
      if (!(error instanceof LocalRuntimeError && /no credentials were found/.test(error.message))) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
}

/** The pid keeps each runtime's record unique, so a stopping runtime never unlinks its successor's. */
function inferenceRecord(served: string, pid: number): string {
  return `${served}\n${pid}`;
}

/** Remove the state files of one spawn, each only while it still holds that runtime's record (a successor's stays). */
function unlinkStateFiles(files: NonNullable<Fields["stateFiles"]>, token: string, pid: number | undefined, record: string | undefined): void {
  if (files.token) unlinkIfContent(files.token, token);
  if (files.pid && pid !== undefined) unlinkIfContent(files.pid, String(pid));
  if (files.inference && record !== undefined) unlinkIfContent(files.inference, record);
}

/** Warn, not fail, on a version skew, so dev binaries stay usable. */
function warnOnVersionSkew(version: string | undefined): void {
  if (version !== undefined && version !== PINNED_RUNTIME_VERSION) {
    console.warn(
      `hai-agent-runtime version skew: server reports ${version}, this SDK pins ${PINNED_RUNTIME_VERSION}; wire-contract drift may cause subtle failures`,
    );
  }
}
