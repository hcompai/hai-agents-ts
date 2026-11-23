// Client.sessions under Node: the auto-bridge layer behind `Client()` and `Client.local()` (src/client/oo.ts),
// against the fake runtime of local.test.ts (tests/fixtures/fake-runtime.mjs).
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client, SessionsClient } from "../src/index.js";
import { LocalRuntime, LocalSessionsClient } from "../src/local/index.js";
import { _localize } from "../src/local/sessions.js";

const FAKE_RUNTIME = fileURLToPath(new URL("./fixtures/fake-runtime.mjs", import.meta.url));
const MAIN_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const JSON_HEADERS = { "Content-Type": "application/json" };
/** A client whose requests all get `status` and `body`, recording each URL hit. */
function clientReplying(status: number, body: unknown) {
  const hits: string[] = [];
  const client = new Client({
    apiKey: "k",
    fetch: async (input: RequestInfo | URL) => {
      hits.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
    },
  });
  return { client, hits };
}
/** What Client.local() builds once it holds a runtime, without its recipe check. */
const bound = (runtime: LocalRuntime) => new Client({ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, fetch: runtime.fetch });

let cacheDir: string;
const started: LocalRuntime[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// Started as local.test.ts starts it: the shared recipe required, and handed to the child.
async function start(): Promise<LocalRuntime> {
  const runtime = await LocalRuntime.ensureStarted({
    command: [process.execPath, FAKE_RUNTIME],
    cacheDir,
    port: await freePort(),
    requiredRecipe: "shared",
    env: { HAI_AGENT_RUNTIME_RECIPE: "shared" },
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
  rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Client.sessions", () => {
  // The cloud brain with local bridges: Python's `Client()`; the bridge layer loads on first use under Node (oo.ts).
  it("auto-bridges under Node: sessions is the local client, loaded on first use", async () => {
    const runtime = await start();
    const client = bound(runtime);
    expect(client.localRuntime).toBeUndefined();
    expect(client.autoBridges).toBe(true);
    expect(client.sessions).toBe(client.sessions);
    expect(client.sessions).toBeInstanceOf(SessionsClient); // the stand-in that delegates to the loaded client
    const sessions = (await client["_localSessions"]) as LocalSessionsClient;
    expect(sessions.bridgedKinds("none")).toEqual([]);
    expect((await client.sessions.listSessions({ size: 1 }).withRawResponse()).rawResponse.status).toBe(200);
    await client.close(); // stops the sessions it bridged (none); the runtime is not its to stop
    expect(runtime.childAlive).toBe(true);
  });

  // oo.ts taps the loading promise: a broken install surfaces at the first call of a method the local client overrides, not as an unhandled rejection.
  it("reports a failed load of the local entry at the first sessions call", async () => {
    // A factory that throws is wrapped by vitest; a module whose client cannot be built rejects the same promise.
    let loaded!: () => void;
    const loading = new Promise<void>((resolve) => (loaded = resolve));
    vi.doMock("hai-agents/local", () => {
      loaded();
      return {
        LocalSessionsClient: class {
          constructor() {
            throw new Error("broken install");
          }
        },
      };
    });
    try {
      const { sessions } = new Client({ apiKey: "k" }); // starts the load; nothing awaits it yet
      await loading;
      await new Promise((resolve) => setImmediate(resolve)); // the load has failed with no caller waiting
      await expect(sessions.getSessionStatus({ id: "s1" })).rejects.toThrow(/broken install/);
    } finally {
      vi.doUnmock("hai-agents/local");
    }
  });

  // A bundler that inlines the SDK leaves no package to resolve `hai-agents/local` from at run time (Node's
  // ERR_MODULE_NOT_FOUND, webpack's MODULE_NOT_FOUND): the generated client serves, with one warning per process,
  // and close() has nothing local to close. Bundled for real: vitest wraps a mock factory's error, so no doMock.
  it("falls back to the generated sessions client, warning once, when the local entry cannot be resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hai-bundle-test-"));
    try {
      const bundle = join(dir, "sdk.mjs");
      await build({ entryPoints: [MAIN_ENTRY], outfile: bundle, bundle: true, platform: "node", format: "esm", external: ["zod"], logLevel: "silent" });
      const script = join(dir, "run.mjs");
      writeFileSync(
        script,
        `import { Client, SessionsClient } from "./sdk.mjs";
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));
const fetch = async () => new Response(JSON.stringify({ status: "running" }), { status: 200, headers: ${JSON.stringify(JSON_HEADERS)} });
const client = new Client({ apiKey: "k", fetch });
const statuses = [(await client.sessions.getSessionStatus({ id: "s1" })).status, (await new Client({ apiKey: "k", fetch }).sessions.getSessionStatus({ id: "s2" })).status];
await client.close();
console.log(JSON.stringify({ statuses, warnings, isSessionsClient: client.sessions instanceof SessionsClient }));
`,
      );
      const { stdout } = await promisify(execFile)(process.execPath, [script]);
      expect(JSON.parse(stdout)).toEqual({
        statuses: ["running", "running"],
        warnings: [expect.stringMatching(/cannot load 'hai-agents\/local'.*autoBridges: false/)],
        isSessionsClient: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The stand-in's promise unwraps lazily, as the generated HttpResponsePromise does: a failure the caller takes
  // through .withRawResponse() reaches the caller once, not Node's unhandled-rejection handler too.
  it("a failed request taken through .withRawResponse() is not also an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { client } = clientReplying(404, { detail: "Session not found" });
      await expect(client.sessions.getSessionStatus({ id: "missing" }).withRawResponse()).rejects.toThrow(/Session not found/);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // A SessionsClient subclass, not a Proxy: a stub a test assigns to a method is honoured, as on the generated client.
  it("is a SessionsClient whose methods a test can stub", async () => {
    const { client, hits } = clientReplying(200, { status: "running" });
    expect(client.sessions).toBeInstanceOf(SessionsClient);
    client.sessions.getSessionStatus = vi.fn(async () => ({ status: "stubbed" })) as unknown as SessionsClient["getSessionStatus"];
    expect(await client.sessions.getSessionStatus({ id: "s1" })).toEqual({ status: "stubbed" });
    expect(hits).toEqual([]);
  });

  // Python's httpx client takes no fetch; the TS client's `fetch` (a proxy dispatcher, instrumentation) must reach the bridges too.
  it("hands the client's fetch to the bridges it starts", async () => {
    const hits: string[] = [];
    const recording: typeof fetch = async (input) => {
      hits.push(String(input));
      return String(input).endsWith("/commands") ? new Response(null, { status: 204 }) : new Response("{}", { status: 200, headers: JSON_HEADERS });
    };
    const request = { body: { agent: { name: "qa", environments: [{ id: "laptop", kind: "web", host: "user_device" }] }, messages: "hi" } };
    const context = { pages: () => [{}], close: async () => undefined };
    const bridges = await _localize({ apiKey: "hk-test", baseUrl: "https://agp.test", fetch: recording } as never, undefined, request as never, {}, {
      web: () => ({ context, driver: () => ({ dispatch: async () => null }) }),
    });
    expect(bridges).toHaveLength(1);
    await bridges[0]!.start();
    await bridges[0]!.stop();
    expect(hits.some((url) => url.startsWith("https://agp.test/api/v1/trajectories/"))).toBe(true);
  });

  it("keeps the generated sessions client without auto bridges, and outside Node", () => {
    expect(new Client({ apiKey: "k", autoBridges: false }).sessions).toBeInstanceOf(SessionsClient);
    vi.spyOn(process, "versions", "get").mockReturnValue({} as NodeJS.ProcessVersions);
    expect(new Client({ apiKey: "k" }).sessions).toBeInstanceOf(SessionsClient);
  });
});
