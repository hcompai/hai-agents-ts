/**
 * Files under the cache dir that let other local processes find a spawned runtime: its bearer
 * token, pid and inference, one set per port. Same layout as the Python SDK, so a runtime
 * started by one SDK can be attached to by the other. Written owner-only (0600).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const CACHE_DIR_ENV = "HAI_AGENT_LOCAL_CACHE_DIR";
export const DEFAULT_PORT = 18795;

/** `~/x` as an absolute path; anything else unchanged. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Explicit argument > HAI_AGENT_LOCAL_CACHE_DIR > ~/.hai/agent-runtime. */
export function resolveCacheDir(cacheDir?: string): string {
  const chosen = cacheDir ?? process.env[CACHE_DIR_ENV]?.trim();
  return chosen ? expandHome(chosen) : join(homedir(), ".hai", "agent-runtime");
}

export function tokenFilePath(port: number, cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "state", `agent-token-${port}`);
}

export function pidFilePath(port: number, cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "state", `agent-pid-${port}`);
}

export function inferenceFilePath(port: number, cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "state", `agent-inference-${port}`);
}

/** Where the runtime spawned on `port` writes its stderr. */
export function runtimeLogPath(port: number, cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "logs", `hai-agent-runtime-${port}.log`);
}

/** Atomically publish `content` at `file`, owner-only, refusing a pre-existing symlink at the path. */
export function writeOwnerOnly(file: string, content: string): string {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700); // no-op on Windows
  } catch {
    // best effort
  }
  if (isSymlink(file)) {
    throw new Error(`refusing to replace the symlink at ${file}`);
  }
  // Staged 0600 then renamed, so readers only ever see complete content.
  const staged = join(dir, `.${basename(file)}.${randomBytes(6).toString("hex")}`);
  writeFileSync(staged, content, { mode: 0o600, flag: "wx" });
  try {
    renameSync(staged, file);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // nothing to clean
    }
    throw error;
  }
  return file;
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The trimmed file contents, or undefined when missing, unreadable or empty. */
export function readStateFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The persisted runtime pid for `port`, or undefined when absent or malformed. */
export function readPid(port: number, cacheDir?: string): number | undefined {
  const raw = readStateFile(pidFilePath(port, cacheDir));
  const pid = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(pid) ? pid : undefined;
}

/** Remove `file` only while it still holds `content`, so a successor runtime's file is never removed. */
export function unlinkIfContent(file: string, content: string): void {
  try {
    if (readFileSync(file, "utf8").trim() === content) {
      unlinkSync(file);
    }
  } catch {
    // already gone or not ours
  }
}
