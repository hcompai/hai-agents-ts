import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { LocalRuntimeError } from "./identity.js";
import { PINNED_RUNTIME_VERSION, resolveBinary } from "./install.js";

const STARTUP_TIMEOUT_MS = 120_000;
// Beyond the runtime's own 10 s teardown, which releases cloud environments.
const TERM_GRACE_MS = 15_000;

/** Where a local runtime listens and how to authenticate; `owned` when this process started it. */
export interface RuntimeHandle {
  url: string;
  token: string;
  pid: number;
  version: string;
  owned: boolean;
  log: string;
}

export interface LocalRuntimeOptions {
  /** The `hai-agent-runtime` executable; defaults to PATH, then the managed install, then a verified download. */
  binaryPath?: string;
  /** Allow downloading the pinned runtime when none is installed. Defaults to true. */
  download?: boolean;
  /** Loopback port; defaults to 18795 for hosted inference and a stable port per self-hosted inference. */
  port?: number;
  /** Key for hosted inference; defaults to HAI_API_KEY. */
  apiKey?: string;
  /** Self-hosted OpenAI-compatible inference; the hosted key is never forwarded to it. */
  inference?: { baseUrl: string; model: string };
  /** Extra runtime environment (`HAI_AGENT_RUNTIME_*`). */
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

export class LocalRuntime {
  private constructor(
    readonly handle: RuntimeHandle,
    private readonly child: ChildProcess | undefined,
  ) {}

  /** Attach to the runtime serving this inference, or start one bound to this process. */
  static async start(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
    const binary = await resolveBinary(options);
    const child = spawn(binary, [], {
      env: runtimeEnv(options),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const handle = await readHandle(child, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    if (handle.version && handle.version !== PINNED_RUNTIME_VERSION) {
      console.warn(`hai-agent-runtime ${handle.version} differs from the pinned ${PINNED_RUNTIME_VERSION}`);
    }
    return new LocalRuntime(handle, handle.owned ? child : undefined);
  }

  get owned(): boolean {
    return this.child !== undefined;
  }

  /** Stop the runtime this process started: SIGTERM its process group, then SIGKILL after the grace period. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.ref();
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      } catch {
        return;
      }
      await exited;
      return;
    }
    const group = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {}
    };
    group("SIGTERM");
    const kill = setTimeout(() => group("SIGKILL"), TERM_GRACE_MS);
    await exited;
    clearTimeout(kill);
  }
}

function runtimeEnv(options: LocalRuntimeOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  env.HAI_AGENT_RUNTIME_ATTACH = "1";
  env.HAI_AGENT_RUNTIME_RECIPE = "shared";
  if (options.apiKey) env.HAI_API_KEY = options.apiKey;
  if (options.port !== undefined) env.HAI_AGENT_RUNTIME_PORT = String(options.port);
  if (options.inference) {
    env.HAI_AGENT_RUNTIME_BASE_URL = options.inference.baseUrl;
    env.HAI_AGENT_RUNTIME_MODEL = options.inference.model;
  }
  if (env.HAI_AGENT_RUNTIME_BASE_URL?.trim()) delete env.HAI_API_KEY;
  return env;
}

function readHandle(child: ChildProcess, timeoutMs: number): Promise<RuntimeHandle> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new LocalRuntimeError(`${message}${stderr.trim() ? `: ${stderr.trim().slice(-4000)}` : ""}`));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(`hai-agent-runtime printed no handle within ${timeoutMs / 1000}s`);
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((candidate, i, all) => i < all.length - 1 && candidate.startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      resolve(JSON.parse(line) as RuntimeHandle);
    });
    child.once("error", (error) => fail(`could not start hai-agent-runtime (${error.message})`));
    child.once("exit", (code, signal) => fail(`hai-agent-runtime exited with ${signal ?? `code ${code}`} before printing a handle`));
  });
}