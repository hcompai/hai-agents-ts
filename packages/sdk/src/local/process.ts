/** Spawn, health-check and stop hai-agent-runtime processes (loopback only). */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { BinaryNotFoundError, LocalRuntimeError, RuntimeStartTimeoutError, RuntimeUnhealthyError } from "./errors.js";
import { provenFetch } from "./identity.js";
import type { Env } from "./inference.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const SPAWN_TIMEOUT_MS = 45_000;
const HEALTH_POLL_INTERVAL_MS = 250;
export const PROBE_TIMEOUT_MS = 2_000;
// Exceeds the runtime's own shutdown teardown (10 s), which releases cloud environments.
const TERM_GRACE_MS = 15_000;
const KILL_WAIT_MS = 2_000;
const LOG_TAIL_CHARS = 4_000;

export type Health = { version?: string; recipe?: string };

export type Spawned = {
  process: ChildProcess;
  exited: boolean;
  /** Set when the command could not start at all (e.g. ENOENT). */
  startError?: Error;
  waitExit(ms: number): Promise<boolean>;
  /** Synchronous work the exit handler does after signalling the runtime: its state files. Python has no exit handler (the runtime's parent watchdog stops it). */
  atExit?: () => void;
};

/** Whether any HTTP server answers at `baseUrl`, proven or not. */
export async function responds(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** The proven `/health` body on a 200; undefined when unreachable or unhealthy. A wrong proof throws. */
export async function probeHealth(baseUrl: string, token: string): Promise<Health | undefined> {
  let response: Response;
  try {
    response = await provenFetch(token)(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof LocalRuntimeError) {
      throw error;
    }
    return undefined;
  }
  if (response.status !== 200) {
    return undefined;
  }
  const body: unknown = await response.json().catch(() => ({}));
  return body && typeof body === "object" ? (body as Health) : {};
}

// spawnRuntime, not Python's spawn: that name is node:child_process's import.
export function spawnRuntime(command: string[], env: Env, logPath: string, log: (m: string) => void): Spawned {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "w");
  log(`spawning hai-agent-runtime: ${command.join(" ")} (stderr -> ${logPath})`);
  const [file, ...args] = command as [string, ...string[]];
  // Its own process group, so a stop reaches any grandchild; stderr to a file, as nobody drains a pipe.
  const child = spawn(file, args, { env, stdio: ["ignore", "ignore", logFd], detached: true, windowsHide: true });
  closeSync(logFd); // the child inherited it
  // The runtime must not keep this process alive; the exit handler can only do synchronous work.
  child.unref();
  const stopAtExit = () => {
    signalTree(child, "SIGTERM");
    spawned.atExit?.();
  };
  process.once("exit", stopAtExit);

  const spawned: Spawned = {
    process: child,
    exited: false,
    waitExit: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        exitPromise.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
  };
  const exitPromise = new Promise<void>((resolve) => {
    const done = () => {
      process.off("exit", stopAtExit);
      spawned.exited = true;
      resolve();
    };
    child.once("exit", done);
    child.once("error", (error: Error) => {
      spawned.startError = error; // e.g. ENOENT: the command could not start at all
      done();
    });
  });
  return spawned;
}

/** Poll `/health` until a proven 200; fail if the child exits first, or the timeout passes. */
export async function waitHealthy(baseUrl: string, token: string, child: Spawned, timeoutMs: number, logPath: string): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await probeHealth(baseUrl, token);
    if (health) {
      return health;
    }
    if (child.startError) {
      // Python's Popen raises FileNotFoundError before the loop; Node's spawn reports ENOENT as an async 'error' event.
      throw new BinaryNotFoundError(`hai-agent-runtime could not start: ${child.startError.message}`);
    }
    if (child.exited) {
      const code = child.process.exitCode ?? child.process.signalCode ?? "unknown";
      throw new RuntimeUnhealthyError(`hai-agent-runtime exited with code ${code}: ${logTail(logPath)} (full log: ${logPath})`);
    }
    if (Date.now() >= deadline) {
      throw new RuntimeStartTimeoutError(`hai-agent-runtime did not become healthy within ${timeoutMs / 1000}s (see ${logPath})`);
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
}

function logTail(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return "(stderr log unreadable)";
  }
  return text ? text.slice(-LOG_TAIL_CHARS) : "(no stderr output)";
}

/** Signal the runtime's process tree; false if it was already gone. */
function signalTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): boolean {
  if (child.pid === undefined) {
    return false;
  }
  if (process.platform === "win32") {
    // No graceful group signal on Windows; /T takes the tree, /F keeps a .cmd shim child from outliving it.
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-child.pid, signal); // negative pid: the process group the detached spawn created
    return true;
  } catch {
    return false;
  }
}

/** Graceful stop: signal the whole process group, wait the grace period, then force-kill it. */
export async function terminate(child: Spawned): Promise<void> {
  if (child.exited) {
    return;
  }
  if (!signalTree(child.process, "SIGTERM")) {
    return;
  }
  if (await child.waitExit(TERM_GRACE_MS)) {
    return;
  }
  if (signalTree(child.process, "SIGKILL") && !(await child.waitExit(KILL_WAIT_MS))) {
    console.warn(`hai-agent-runtime (pid ${child.process.pid}) did not exit after forced kill`);
  }
}

/** A referenced timer on purpose: an awaited startup or stop must keep the process alive, the unref'd child does not. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
