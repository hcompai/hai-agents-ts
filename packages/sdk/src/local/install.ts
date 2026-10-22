import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { LocalRuntimeError } from "./identity.js";
import pin from "./pin.json";

export const BINARY_PATH_ENV = "HAI_AGENT_LOCAL_BINARY_PATH";
export const DOWNLOAD_URL_ENV = "HAI_AGENT_RUNTIME_DOWNLOAD_URL";
export const DOWNLOAD_SHA256_ENV = "HAI_AGENT_RUNTIME_DOWNLOAD_SHA256";
const CDN = "https://assets.hcompanyprod.fr/hai-agent-runtime";
const BINARY = process.platform === "win32" ? "hai-agent-runtime.exe" : "hai-agent-runtime";
const MAX_DOWNLOAD_BYTES = 1024 ** 3;

export const PINNED_RUNTIME_VERSION: string = pin.version;

export function cacheDir(): string {
  return process.env.HAI_AGENT_LOCAL_CACHE_DIR?.trim() || join(homedir(), ".hai", "agent-runtime");
}

/** Explicit path > HAI_AGENT_LOCAL_BINARY_PATH > PATH > managed install > verified download. */
export async function resolveBinary(options: { binaryPath?: string; download?: boolean }): Promise<string> {
  const explicit = options.binaryPath ?? process.env[BINARY_PATH_ENV]?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new LocalRuntimeError(`binaryPath / ${BINARY_PATH_ENV} points at a missing file: ${explicit}`);
    return explicit;
  }
  const found = onPath() ?? findBinary(join(cacheDir(), "bin", PINNED_RUNTIME_VERSION));
  if (found) return found;
  if (options.download === false) {
    throw new LocalRuntimeError("hai-agent-runtime is not installed and download is false; pass binaryPath");
  }
  return install();
}

function onPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, BINARY))) return join(dir, BINARY);
  }
  return undefined;
}

function findBinary(root: string): string | undefined {
  if (existsSync(join(root, BINARY))) return join(root, BINARY);
  const bundle = existsSync(root) ? readdirSync(root).find((name) => name.endsWith(".app")) : undefined;
  const nested = bundle && join(root, bundle, "Contents", "MacOS", BINARY);
  return nested && existsSync(nested) ? nested : undefined;
}

function platformKey(): string {
  const system = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  const arch = { arm64: "arm64", x64: "x86_64" }[process.arch as string];
  if (!system || !arch) throw new LocalRuntimeError(`hai-agent-runtime is not published for ${process.platform}-${process.arch}`);
  return `${system}-${arch}`;
}

function artifact(): { url: string; sha256: string } {
  const url = process.env[DOWNLOAD_URL_ENV]?.trim();
  if (url) {
    const sha256 = process.env[DOWNLOAD_SHA256_ENV]?.trim();
    if (!sha256) throw new LocalRuntimeError(`${DOWNLOAD_URL_ENV} is set without ${DOWNLOAD_SHA256_ENV}; refusing an unverified download`);
    return { url, sha256 };
  }
  const key = platformKey();
  const sha256 = (pin.sha256 as Record<string, string>)[key];
  if (!sha256) {
    throw new LocalRuntimeError(
      `hai-agent-runtime ${PINNED_RUNTIME_VERSION} has no published artifact for ${key}; pass binaryPath or put hai-agent-runtime on PATH`,
    );
  }
  return { url: `${CDN}/${PINNED_RUNTIME_VERSION}/hai-agent-runtime-${key}.zip`, sha256 };
}

async function install(): Promise<string> {
  const { url, sha256 } = artifact();
  const root = join(cacheDir(), "bin");
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".staging-"));
  try {
    const archive = join(staging, "artifact.zip");
    const actual = await download(url, archive);
    if (actual !== sha256.toLowerCase()) {
      throw new LocalRuntimeError(`hai-agent-runtime download failed sha256 verification: expected ${sha256}, got ${actual} (${url})`);
    }
    const staged = join(staging, "version");
    mkdirSync(staged);
    extract(archive, staged);
    const binary = findBinary(staged);
    if (!binary) throw new LocalRuntimeError(`downloaded artifact contains no hai-agent-runtime executable (${url})`);
    chmodSync(binary, 0o755);
    const target = join(root, PINNED_RUNTIME_VERSION);
    try {
      renameSync(staged, target);
    } catch {
      const existing = findBinary(target);
      if (existing) return existing;
      rmSync(target, { recursive: true, force: true });
      renameSync(staged, target);
    }
    return findBinary(target)!;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function requireSecure(url: string): void {
  const { protocol, hostname } = new URL(url);
  if (protocol === "https:" || (protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(hostname))) return;
  throw new LocalRuntimeError(`refusing insecure hai-agent-runtime download URL (need https): ${url}`);
}

async function download(url: string, dest: string): Promise<string> {
  requireSecure(url);
  const response = await fetch(url, { redirect: "follow" });
  requireSecure(response.url || url);
  if (!response.ok || !response.body) throw new LocalRuntimeError(`hai-agent-runtime download failed: HTTP ${response.status} from ${url}`);
  const digest = createHash("sha256");
  const file = createWriteStream(dest);
  let written = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      written += chunk.length;
      if (written > MAX_DOWNLOAD_BYTES) throw new LocalRuntimeError(`hai-agent-runtime download exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
      digest.update(chunk);
      if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }
  return digest.digest("hex");
}

function extract(archive: string, dest: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["ditto", ["-x", "-k", archive, dest]]
      : process.platform === "win32"
        ? ["tar", ["-xf", archive, "-C", dest]]
        : ["unzip", ["-q", archive, "-d", dest]];
  try {
    execFileSync(command, args, { stdio: "ignore" });
  } catch {
    throw new LocalRuntimeError(`extracting the hai-agent-runtime archive needs \`${command}\` on PATH`);
  }
}
