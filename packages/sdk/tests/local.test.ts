import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provenFetch, runtimeProof, verifyProof } from "../src/local/identity.js";
import { installRuntime, pinnedArtifact } from "../src/local/install.js";
import { platformKey } from "../src/local/manifest.js";
import { inferenceFilePath, tokenFilePath, pidFilePath, writeOwnerOnly } from "../src/local/state.js";
import { Client } from "../src/index.js";
import {
  BinaryIncompatibleError,
  BinaryNotFoundError,
  DownloadVerificationError,
  Inference,
  LocalRuntime,
  LocalRuntimeError,
  RuntimeUnhealthyError,
  defaultPort,
} from "../src/local/index.js";
import { servedInference } from "../src/local/inference.js";
import { extractZip } from "../src/local/zip.js";

// The launcher is exercised against a fake runtime binary (tests/fixtures/fake-runtime.mjs)
// that applies the real one's bearer check and identity proof, in an isolated cache dir.

const FAKE_RUNTIME = fileURLToPath(new URL("./fixtures/fake-runtime.mjs", import.meta.url));
/** What Client.local() builds once it holds a runtime, without its recipe check. */
const bound = (runtime: LocalRuntime) => new Client({ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, fetch: runtime.fetch });
const fake = (extra: string[] = []) => [process.execPath, FAKE_RUNTIME, ...extra];

let cacheDir: string;
const started: LocalRuntime[] = [];
const servers: Server[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// Started as Client.local() starts it: the shared recipe required, and handed to the child.
async function start(options: Parameters<typeof LocalRuntime.ensureStarted>[0] = {}): Promise<LocalRuntime> {
  const runtime = await LocalRuntime.ensureStarted({
    command: fake(),
    cacheDir,
    port: await freePort(),
    requiredRecipe: "shared",
    ...options,
    env: { HAI_AGENT_RUNTIME_RECIPE: "shared", ...options.env },
  });
  if (runtime.owned) started.push(runtime);
  return runtime;
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "hai-local-test-"));
  vi.stubEnv("HAI_AGENT_LOCAL_BASE_URL", "");
  vi.stubEnv("HAI_AGENT_RUNTIME_PORT", "");
  vi.stubEnv("HAI_AGENT_RUNTIME_API_TOKEN", "");
  vi.stubEnv("HAI_API_KEY", "hk-test");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const runtime of started.splice(0)) {
    if (runtime.childAlive) await runtime.shutdown();
  }
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("identity proof", () => {
  it("accepts a response that answers the challenge with the token's HMAC", () => {
    const response = new Response(null, { headers: { "X-Hai-Runtime-Proof": runtimeProof("tok", "chal") } });
    expect(() => verifyProof("tok", "http://127.0.0.1:1", "chal", response)).not.toThrow();
  });

  it("rejects a missing or wrong proof", () => {
    const wrong = new Response(null, { headers: { "X-Hai-Runtime-Proof": runtimeProof("other", "chal") } });
    expect(() => verifyProof("tok", "http://127.0.0.1:1", "chal", wrong)).toThrow(LocalRuntimeError);
    expect(() => verifyProof("tok", "http://127.0.0.1:1", "chal", new Response(null))).toThrow(/did not prove/);
  });

  it("never follows a redirect: a squatter answering 307 to another origin never sees the bearer token", async () => {
    const seen: string[] = [];
    const elsewhere = createServer((req, res) => {
      seen.push(req.headers.authorization ?? "none");
      res.end("{}");
    }).listen(0, "127.0.0.1");
    servers.push(elsewhere);
    await new Promise((resolve) => elsewhere.once("listening", resolve));
    const target = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}`;
    const squatter = createServer((req, res) => {
      res.writeHead(307, { Location: `${target}${req.url}` });
      res.end();
    }).listen(0, "127.0.0.1");
    servers.push(squatter);
    await new Promise((resolve) => squatter.once("listening", resolve));
    const port = (squatter.address() as { port: number }).port;
    const fetchProven = provenFetch("tok");
    await expect(fetchProven(`http://127.0.0.1:${port}/health`, { headers: { Authorization: "Bearer tok" } })).rejects.toThrow(/did not prove/);
    // Through the launcher too: the squatter holds a port whose token is published.
    writeOwnerOnly(tokenFilePath(port, cacheDir), "tok");
    await expect(start({ port })).rejects.toThrow(/did not prove/);
    expect(seen).toEqual([]);
  });
});

describe("inference placement", () => {
  it("defaults to hosted on the default port, self-hosted on its own stable port", () => {
    expect(servedInference({})).toBe("hosted");
    expect(defaultPort("hosted")).toBe(18795);
    const served = servedInference(Inference.selfHosted("http://127.0.0.1:8000/v1", "holo4").runtimeEnv({}));
    expect(served).toBe("http://127.0.0.1:8000/v1 holo4");
    expect(defaultPort(served)).toBe(defaultPort(served));
    expect(defaultPort(served)).toBeGreaterThan(18795);
    expect(defaultPort(served)).toBeLessThanOrEqual(18795 + 1000);
  });

  it("rejects endpoints that are not plain HTTP(S) or carry credentials", () => {
    expect(() => Inference.selfHosted("ftp://x/v1", "m")).toThrow();
    expect(() => Inference.selfHosted("http://user@x/v1", "m")).toThrow();
    expect(() => Inference.selfHosted("http://x/v1", "")).toThrow();
  });
});

describe("LocalRuntime.ensureStarted", () => {
  it("spawns the runtime, proves it, and publishes its token for other local clients", async () => {
    const runtime = await start();
    expect(runtime.owned).toBe(true);
    expect(runtime.version).toBe("0.0.0-fake");
    expect(runtime.recipe).toBe("shared");
    expect(runtime.childAlive).toBe(true);
    const port = Number(new URL(runtime.baseUrl).port);
    expect(readFileSync(tokenFilePath(port, cacheDir), "utf8")).toBe(runtime.apiKey);
    expect(readFileSync(pidFilePath(port, cacheDir), "utf8")).toBe(String(runtime.pid));
    expect(existsSync(runtime.logPath!)).toBe(true);
  });

  it("lets a start that loses the port to a concurrent one attach to the winner, as under Python's lock", async () => {
    const port = await freePort();
    const [first, second] = await Promise.all([start({ port }), start({ port })]);
    expect([first.owned, second.owned].sort()).toEqual([false, true]);
    expect(second.apiKey).toBe(first.apiKey);
    expect(second.pid).toBe(first.pid);
  });

  it("attaches to a runtime another client started instead of spawning a second one", async () => {
    const first = await start();
    const port = Number(new URL(first.baseUrl).port);
    const second = await LocalRuntime.ensureStarted({ command: fake(), cacheDir, port });
    expect(second.owned).toBe(false);
    expect(second.apiKey).toBe(first.apiKey);
    expect(second.pid).toBe(first.pid);
    expect(await LocalRuntime.attach({ cacheDir, port })).toMatchObject({ owned: false, apiKey: first.apiKey });
    await expect(second.shutdown()).rejects.toThrow(/only stops runtimes this LocalRuntime spawned/);
  });

  it("stops the runtime and removes its state files on shutdown", async () => {
    const runtime = await start();
    const port = Number(new URL(runtime.baseUrl).port);
    await runtime.shutdown();
    expect(runtime.childAlive).toBe(false);
    expect(existsSync(tokenFilePath(port, cacheDir))).toBe(false);
    expect(existsSync(pidFilePath(port, cacheDir))).toBe(false);
    expect(await LocalRuntime.attach({ cacheDir, port })).toBeUndefined();
  });

  it("stops an owned runtime and removes its state files when this process exits without close()", async () => {
    const runtime = await start();
    const port = Number(new URL(runtime.baseUrl).port);
    process.emit("exit", 0); // what Node does on the way out; the handler must work synchronously
    expect(existsSync(tokenFilePath(port, cacheDir))).toBe(false);
    expect(existsSync(pidFilePath(port, cacheDir))).toBe(false);
    await vi.waitFor(() => expect(runtime.childAlive).toBe(false));
  });

  it("starts the shared recipe even when the shell exports another one", async () => {
    vi.stubEnv("HAI_AGENT_RUNTIME_RECIPE", "desktop");
    const client = await Client.local({ command: fake(), cacheDir, port: await freePort() });
    started.push(client.localRuntime!);
    expect(client.localRuntime!.recipe).toBe("shared");
  });

  it("requires a recipe only when asked, and re-probes it on attach", async () => {
    const port = await freePort();
    const any = await LocalRuntime.ensureStarted({ command: fake(), cacheDir, port });
    started.push(any);
    expect(any.recipe).toBe("legacy"); // the fake's default when nothing is asked
    const attach = LocalRuntime.ensureStarted({ command: fake(), cacheDir, port, requiredRecipe: "shared" });
    await expect(attach).rejects.toThrow(/must support recipe "shared"/);
    expect(any.childAlive).toBe(true); // refused, not stopped: it is not ours
    // The live /health answers, not a stale field.
    const stale = new LocalRuntime({ baseUrl: any.baseUrl, apiKey: any.apiKey, owned: false, recipe: "shared" });
    await expect(stale.requireRecipe("shared")).rejects.toThrow(BinaryIncompatibleError);
  });

  it("leaves a successor's token file alone on shutdown", async () => {
    const runtime = await start();
    const tokenFile = tokenFilePath(Number(new URL(runtime.baseUrl).port), cacheDir);
    writeFileSync(tokenFile, "other");
    await runtime.shutdown();
    expect(readFileSync(tokenFile, "utf8")).toBe("other");
  });

  it("reports a command that cannot start", async () => {
    await expect(start({ command: [join(cacheDir, "missing-runtime")] })).rejects.toThrow(/could not start: .*ENOENT/);
  });

  it("reports a runtime that exits during startup, with its stderr", async () => {
    await expect(start({ env: { FAKE_RUNTIME_EXIT: "1" } })).rejects.toThrow(/exited with code 3: fake runtime refusing to start/);
  });

  it("refuses a runtime that does not serve the shared recipe, and stops it", async () => {
    const port = await freePort();
    await expect(start({ port, env: { HAI_AGENT_RUNTIME_RECIPE: "legacy" } })).rejects.toThrow(BinaryIncompatibleError);
    expect(await LocalRuntime.attach({ cacheDir, port })).toBeUndefined();
  });

  it("refuses a port held by a server that cannot prove it is our runtime", async () => {
    const port = await freePort();
    const server = createServer((_req, res) => res.end("{}")).listen(port, "127.0.0.1");
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    // No token published for that port: the launcher cannot even authenticate.
    await expect(start({ port })).rejects.toThrow(/no credentials were found/);
    // A token is published, but the server does not answer the challenge.
    writeOwnerOnly(tokenFilePath(port, cacheDir), "stale-token");
    await expect(start({ port })).rejects.toThrow(/did not prove/);
  });

  it("passes self-hosted inference to the runtime without the H key, on a derived port", async () => {
    const inference = Inference.selfHosted("http://127.0.0.1:8000/v1", "holo4");
    const runtime = await LocalRuntime.ensureStarted({ command: fake(), cacheDir, inference });
    started.push(runtime);
    expect(new URL(runtime.baseUrl).port).toBe(String(defaultPort("http://127.0.0.1:8000/v1 holo4")));
    expect(runtime.serves).toBe("http://127.0.0.1:8000/v1 holo4");
    const env = await runtime.fetch(`${runtime.baseUrl}/fake/env`, { headers: { Authorization: `Bearer ${runtime.apiKey}` } }).then((r) => r.json());
    expect(env.HAI_API_KEY).toBeUndefined();
    expect(env.HAI_AGENT_RUNTIME_BASE_URL).toBe("http://127.0.0.1:8000/v1");
    expect(env.HAI_AGENT_RUNTIME_MODEL).toBe("holo4");
    // A hosted-inference client must not borrow it.
    const port = Number(new URL(runtime.baseUrl).port);
    await expect(LocalRuntime.ensureStarted({ command: fake(), cacheDir, port })).rejects.toThrow(/infers against/);
  });

  it("forwards the H key to the runtime for hosted inference", async () => {
    const runtime = await start({ apiKey: "hk-explicit" });
    const env = await runtime.fetch(`${runtime.baseUrl}/fake/env`, { headers: { Authorization: `Bearer ${runtime.apiKey}` } }).then((r) => r.json());
    expect(env.HAI_API_KEY).toBe("hk-explicit");
  });

  it("withholds the H key when the environment, not an option, selects a self-hosted server", async () => {
    const runtime = await LocalRuntime.ensureStarted({ command: fake(), cacheDir, env: { HAI_AGENT_RUNTIME_BASE_URL: "http://127.0.0.1:8000/v1" } });
    started.push(runtime);
    const env = await runtime.fetch(`${runtime.baseUrl}/fake/env`, { headers: { Authorization: `Bearer ${runtime.apiKey}` } }).then((r) => r.json());
    expect(env.HAI_API_KEY).toBeUndefined();
    expect(runtime.serves).toBe("http://127.0.0.1:8000/v1");
  });

  it("explains what to do when no binary can be found", async () => {
    vi.stubEnv("PATH", cacheDir);
    vi.stubEnv("HAI_AGENT_LOCAL_BINARY_PATH", "");
    await expect(LocalRuntime.ensureStarted({ cacheDir, port: await freePort() })).rejects.toThrow(BinaryNotFoundError);
    await expect(LocalRuntime.ensureStarted({ cacheDir, port: await freePort() })).rejects.toThrow(/download: true/);
  });

  it("refuses to download a version it holds no digest for", async () => {
    vi.stubEnv("PATH", cacheDir);
    vi.stubEnv("HAI_AGENT_LOCAL_BINARY_PATH", "");
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_URL", "");
    const options = { cacheDir, port: await freePort(), version: "0.0.1", download: true };
    await expect(LocalRuntime.ensureStarted(options)).rejects.toThrow(BinaryIncompatibleError);
    await expect(LocalRuntime.ensureStarted(options)).rejects.toThrow(/pins sha256 digests for/);
  });
});

describe("Client.local", () => {
  it("returns a client whose requests go to the runtime, proof-checked", async () => {
    const client = await Client.local({ command: fake(), cacheDir, port: await freePort() });
    started.push(client.localRuntime!);
    expect(client).toBeInstanceOf(Client);
    expect(client.localRuntime!.owned).toBe(true);
    const page = await client.sessions.listSessions({ size: 1 });
    expect(page.items).toEqual([]);
    await client.close();
    expect(client.localRuntime!.childAlive).toBe(false);
  });

  it("builds the subclass it is called on, as Python's classmethod", async () => {
    class Mine extends Client {}
    const client = await Mine.local({ runtime: await start() });
    expect(client).toBeInstanceOf(Mine);
    expect(client.localRuntime?.recipe).toBe("shared");
  });

  // The main entry is browser-safe; only Node can load the local entry, so the check happens before the load.
  it("needs Node.js", async () => {
    vi.spyOn(process, "versions", "get").mockReturnValue({} as NodeJS.ProcessVersions);
    await expect(Client.local()).rejects.toThrow("Client.local() needs Node.js: the local runtime runs on this machine");
  });

  it("leaves a runtime the caller spawned alone when the client cannot be built", async () => {
    const runtime = await start();
    class Broken extends Client {
      constructor() {
        super();
        throw new Error("no client");
      }
    }
    await expect(Broken.local({ runtime })).rejects.toThrow("no client");
    expect(runtime.childAlive).toBe(true);
  });

  it("refuses to attach to a runtime that serves another recipe", async () => {
    const port = await freePort();
    const legacy = await LocalRuntime.ensureStarted({ command: fake(), cacheDir, port });
    started.push(legacy);
    await expect(Client.local({ command: fake(), cacheDir, port })).rejects.toThrow(BinaryIncompatibleError);
    expect(legacy.childAlive).toBe(true);
  });

  // Python's _claim guard (acquire.py); its suite has no test of it.
  it("refuses to attach a self-hosted client to a runtime whose inference is unknown, and leaves it running", async () => {
    const legacy = await start();
    const port = Number(new URL(legacy.baseUrl).port);
    rmSync(inferenceFilePath(port, cacheDir));
    const inference = Inference.selfHosted("http://127.0.0.1:8000/v1", "holo4");
    await expect(Client.local({ command: fake(), cacheDir, port, inference })).rejects.toThrow(
      "a runtime of unknown inference already listens there; stop it or set HAI_AGENT_RUNTIME_PORT to another port",
    );
    expect(legacy.childAlive).toBe(true);
  });

  // Python: `with Client.local() as client:`; the async disposable is the TS idiom.
  it("stops what close() stops at the end of an `await using` block", async () => {
    let runtime: LocalRuntime;
    {
      await using client = await Client.local({ command: fake(), cacheDir, port: await freePort() });
      runtime = client.localRuntime!;
      started.push(runtime);
      expect(runtime.childAlive).toBe(true);
    }
    expect(runtime.childAlive).toBe(false);
  });

  it("wraps a runtime the caller holds, and does not stop it on close", async () => {
    const runtime = await start();
    const client = await Client.local({ runtime: (await LocalRuntime.attach({ cacheDir, port: Number(new URL(runtime.baseUrl).port) }))! });
    expect(client.localRuntime!.owned).toBe(false);
    await client.close();
    expect(runtime.childAlive).toBe(true);
    await expect(Client.local({ runtime, download: true })).rejects.toThrow(/owns its inference and launch configuration/);
  });

  it("rejects responses from a runtime that does not hold the client's token", async () => {
    const runtime = await start();
    const client = bound(runtime);
    // Same port, another token: what a client sees once a different runtime has taken the port over.
    const forged = bound(new LocalRuntime({ baseUrl: runtime.baseUrl, apiKey: "another-token", owned: false }));
    await expect(forged.sessions.listSessions({ size: 1 })).rejects.toThrow(/did not prove/);
    expect((await client.sessions.listSessions({ size: 1 })).total).toBe(0);
  });
});

/** A stored (uncompressed) zip built by hand, so an entry can be named anything, e.g. `../x`. */
function storedZip(entries: Array<[name: string, content: string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

describe("install", () => {
  const hasZip = (() => {
    try {
      execFileSync("zip", ["-v"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  function serve(file: string): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(readFileSync(file));
    });
    servers.push(server);
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/runtime.zip`)),
    );
  }

  it("requires a digest alongside a download URL override", () => {
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_URL", "https://example.test/r.zip");
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_SHA256", "");
    expect(() => pinnedArtifact()).toThrow(DownloadVerificationError);
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_SHA256", "ab".repeat(32));
    expect(pinnedArtifact()).toEqual({ url: "https://example.test/r.zip", sha256: "ab".repeat(32) });
  });

  it.skipIf(platformKey() === "darwin-x86_64")("refuses a pinned entry that is missing or still the placeholder", () => {
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_URL", "");
    expect(() => pinnedArtifact({ version: "9.9.9", sha256: {} })).toThrow(/no hai-agent-runtime release artifact/);
    expect(() => pinnedArtifact({ version: "9.9.9", sha256: { [platformKey()]: "0".repeat(64) } })).toThrow(/no published artifact/);
  });

  it("refuses a zip entry that escapes the destination", () => {
    const zipPath = join(cacheDir, "escape.zip");
    writeFileSync(zipPath, storedZip([["ok.txt", "fine"], ["../escaped.txt", "nope"]]));
    const dest = join(cacheDir, "dest");
    expect(() => extractZip(zipPath, dest)).toThrow(/escapes the destination/);
    expect(readFileSync(join(dest, "ok.txt"), "utf8")).toBe("fine"); // the archive itself was readable
    expect(existsSync(join(cacheDir, "escaped.txt"))).toBe(false);
  });

  it("routes the download through HTTPS_PROXY, as Python's httpx does", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "");
    const closedPort = await freePort();
    vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${closedPort}`);
    const install = installRuntime({ url: "https://example.test/r.zip", sha256: "0".repeat(64) }, "9.9.9", cacheDir);
    await expect(install).rejects.toThrow(`ECONNREFUSED 127.0.0.1:${closedPort}`); // the proxy, not example.test
  });

  it("leaves NO_PROXY hosts off the proxy", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "");
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${await freePort()}`);
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    writeFileSync(join(cacheDir, "not-a.zip"), "not a zip");
    const url = await serve(join(cacheDir, "not-a.zip"));
    // Reached loopback directly: the digest check is what fails, not the connection.
    await expect(installRuntime({ url, sha256: "ab".repeat(32) }, "9.9.9", cacheDir)).rejects.toThrow(DownloadVerificationError);
  });

  it("refuses a version that is not one path segment", async () => {
    const artifact = { url: "https://example.test/r.zip", sha256: "0".repeat(64) };
    for (const version of ["", "..", "a/b"]) {
      await expect(installRuntime(artifact, version, cacheDir)).rejects.toThrow(/single path segment/);
    }
  });

  it("refuses plain-http downloads off loopback", async () => {
    await expect(installRuntime({ url: "http://example.test/r.zip", sha256: "0".repeat(64) }, "9.9.9", cacheDir)).rejects.toThrow(/need https/);
  });

  it.skipIf(!hasZip)("verifies the sha256 and installs the executable out of an app-bundle zip", async () => {
    // Shape of the macOS release: <name>.app/Contents/MacOS/hai-agent-runtime, plus other files.
    const src = join(cacheDir, "src");
    mkdirSync(join(src, "hai_agent_runtime.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(src, "hai_agent_runtime.app", "Contents", "MacOS", "hai-agent-runtime"), "#!/bin/sh\necho hi\n");
    writeFileSync(join(src, "hai_agent_runtime.app", "Contents", "Info.plist"), "<plist/>".repeat(100));
    const zipPath = join(cacheDir, "runtime.zip");
    execFileSync("zip", ["-qr", zipPath, "hai_agent_runtime.app"], { cwd: src });
    const url = await serve(zipPath);
    await expect(installRuntime({ url, sha256: "ab".repeat(32) }, "9.9.9", cacheDir)).rejects.toThrow(DownloadVerificationError);
    expect(readdirSync(join(cacheDir, "bin"))).toEqual([]); // the failed install left no staging dir behind
    const right = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    const binary = await installRuntime({ url, sha256: right }, "9.9.9", cacheDir);
    expect(binary).toBe(join(cacheDir, "bin", "9.9.9", "hai_agent_runtime.app", "Contents", "MacOS", "hai-agent-runtime"));
    expect(readFileSync(binary, "utf8")).toContain("echo hi");
    if (process.platform !== "win32") expect(statSync(binary).mode & 0o111).toBe(0o111);
    expect(readFileSync(join(cacheDir, "bin", "9.9.9", "hai_agent_runtime.app", "Contents", "Info.plist"), "utf8")).toContain("<plist/>");
    expect(readdirSync(join(cacheDir, "bin"))).toEqual(["9.9.9"]);
  });
});
