/** Verified download and atomic install of the hai-agent-runtime binary; consent to download is the caller's `download: true`. */

import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { BinaryIncompatibleError, DownloadVerificationError, LocalRuntimeError } from "./errors.js";
import {
  BINARY_NAME,
  PLACEHOLDER_SHA256,
  type RuntimeArtifact,
  UNIMPLEMENTED_PLATFORMS,
  artifactUrl,
  platformKey,
} from "./manifest.js";
import pin from "./pin.json" with { type: "json" };
import { resolveCacheDir } from "./state.js";
import { extractZip } from "./zip.js";

export const DOWNLOAD_URL_ENV = "HAI_AGENT_RUNTIME_DOWNLOAD_URL";
export const DOWNLOAD_SHA256_ENV = "HAI_AGENT_RUNTIME_DOWNLOAD_SHA256";

// Ceiling against a lying or absent Content-Length.
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Allow https anywhere, plain http only against loopback (test and ops overrides); reject the rest. */
function requireSecureUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
    return;
  }
  throw new LocalRuntimeError(`refusing insecure download URL (need https): ${url}`);
}

function binDir(version: string, cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "bin", version);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findBinary(root: string): string | undefined {
  const direct = join(root, BINARY_NAME);
  if (isFile(direct)) {
    return direct;
  }
  // macOS app-bundle shape: <root>/<name>.app/Contents/MacOS/hai-agent-runtime
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const entry of entries.filter((e) => e.endsWith(".app")).sort()) {
    const candidate = join(root, entry, "Contents", "MacOS", "hai-agent-runtime");
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** The managed install's executable for `version`, or undefined if absent or incomplete. */
export function installedBinary(version: string, cacheDir?: string): string | undefined {
  return findBinary(binDir(version, cacheDir));
}

/** The artifact to install: an env override (tests, ops) or `pinned`'s entry for this platform. */
export function pinnedArtifact(pinned: { version: string; sha256: Record<string, string> } = pin): RuntimeArtifact {
  const overrideUrl = process.env[DOWNLOAD_URL_ENV]?.trim();
  if (overrideUrl) {
    const overrideSha = process.env[DOWNLOAD_SHA256_ENV]?.trim();
    if (!overrideSha) {
      throw new DownloadVerificationError(
        `${DOWNLOAD_URL_ENV} is set but ${DOWNLOAD_SHA256_ENV} is not; refusing an unverified download`,
      );
    }
    return { url: overrideUrl, sha256: overrideSha };
  }
  const key = platformKey();
  const trusted = `put hai-agent-runtime on PATH, or set ${DOWNLOAD_URL_ENV} + ${DOWNLOAD_SHA256_ENV} to a trusted build`;
  if (key in UNIMPLEMENTED_PLATFORMS) {
    throw new BinaryIncompatibleError(`${UNIMPLEMENTED_PLATFORMS[key]}; ${trusted}`);
  }
  const sha256 = pinned.sha256[key];
  if (!sha256) {
    throw new BinaryIncompatibleError(`no hai-agent-runtime release artifact for platform ${key}`);
  }
  if (sha256 === PLACEHOLDER_SHA256) {
    throw new BinaryIncompatibleError(
      `hai-agent-runtime v${pinned.version} has no published artifact for ${key} yet; ${trusted}`,
    );
  }
  return { url: artifactUrl(pinned.version, key), sha256 };
}

// A staging directory this old was left by an interrupted install (Ctrl-C runs no `finally`), not by a download in progress.
const STALE_STAGING_MS = 60 * 60 * 1000;

/** Download, sha256-verify and atomically install `artifact` as `version`; returns the executable path. */
export async function installRuntime(artifact: RuntimeArtifact, version: string, cacheDir?: string): Promise<string> {
  // The version names the install directory: one path segment, or the install lands elsewhere under the cache.
  if (!version || version === "." || version === ".." || /[\\/]/.test(version)) {
    throw new LocalRuntimeError(`hai-agent-runtime version must be a single path segment, got ${JSON.stringify(version)}`);
  }
  const root = join(resolveCacheDir(cacheDir), "bin");
  mkdirSync(root, { recursive: true });
  const versionDir = join(root, version);
  sweepStaleStaging(root);

  // Staged next to the final location, so the last rename is atomic on the same filesystem.
  const staging = mkdtempSync(join(root, ".staging-"));
  try {
    const download = join(staging, "artifact");
    const actualSha256 = await downloadTo(artifact.url, download);
    if (actualSha256 !== artifact.sha256.toLowerCase()) {
      throw new DownloadVerificationError(
        `hai-agent-runtime download failed sha256 verification: expected ${artifact.sha256}, got ${actualSha256} (url: ${artifact.url})`,
      );
    }

    const stagedVersion = join(staging, "version");
    mkdirSync(stagedVersion);
    if (artifact.url.endsWith(".zip")) {
      extractZip(download, stagedVersion); // contents verified above, so extraction is trusted
    } else {
      renameSync(download, join(stagedVersion, BINARY_NAME));
    }
    const binary = findBinary(stagedVersion);
    if (!binary) {
      throw new LocalRuntimeError(`downloaded artifact contains no hai-agent-runtime executable (url: ${artifact.url})`);
    }
    chmodSync(binary, 0o755); // zip entries do not carry the exec bit

    try {
      renameSync(stagedVersion, versionDir);
    } catch {
      // Target occupied: a concurrent installer won the race, or a half-finished dir is in the way.
      const existing = installedBinary(version, cacheDir);
      if (existing) {
        return existing;
      }
      rmSync(versionDir, { recursive: true, force: true });
      renameSync(stagedVersion, versionDir);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const installed = installedBinary(version, cacheDir);
  if (!installed) {
    throw new LocalRuntimeError(`hai-agent-runtime ${version} install did not produce an executable under ${versionDir}`);
  }
  return installed;
}

/** Python's TemporaryDirectory cleans up on KeyboardInterrupt; Node's `finally` does not run on a fatal signal, so the next install sweeps. */
function sweepStaleStaging(root: string): void {
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith(".staging-")) continue;
    const path = join(root, entry);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_STAGING_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // gone meanwhile
    }
  }
}

/**
 * GET through the proxy the environment names (HTTP_PROXY, HTTPS_PROXY, NO_PROXY), as Python's httpx
 * does. Node's fetch reads them only with NODE_USE_ENV_PROXY set; otherwise undici's agent reads them here.
 */
async function proxyAwareGet(url: string): Promise<Response> {
  if (process.env.NODE_USE_ENV_PROXY === "1") {
    return fetch(url, { redirect: "follow" });
  }
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  return undiciFetch(url, { redirect: "follow", dispatcher: new EnvHttpProxyAgent() }) as unknown as Promise<Response>;
}

/** fetch reports "fetch failed" and keeps the reason (ECONNREFUSED, ENOTFOUND...) in `cause`. */
function describeFetchError(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${String(error)}${cause}`;
}

/** Stream `url` into `dest`; returns the sha256 hex digest of the bytes written. */
async function downloadTo(url: string, dest: string): Promise<string> {
  requireSecureUrl(url);
  let response: Response;
  try {
    response = await proxyAwareGet(url);
  } catch (error) {
    throw new LocalRuntimeError(`hai-agent-runtime download failed: ${describeFetchError(error)} (url: ${url})`, { cause: error });
  }
  requireSecureUrl(response.url || url); // a redirect must not downgrade to plain http
  if (response.status !== 200 || !response.body) {
    throw new LocalRuntimeError(`hai-agent-runtime download failed: HTTP ${response.status} from ${url}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new LocalRuntimeError(`hai-agent-runtime download too large: ${total} bytes exceeds ${MAX_DOWNLOAD_BYTES}`);
  }

  const digest = createHash("sha256");
  let written = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > MAX_DOWNLOAD_BYTES) {
        callback(new LocalRuntimeError(`hai-agent-runtime download exceeded ${MAX_DOWNLOAD_BYTES} bytes; aborting`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), hashing, createWriteStream(dest));
  return digest.digest("hex");
}
