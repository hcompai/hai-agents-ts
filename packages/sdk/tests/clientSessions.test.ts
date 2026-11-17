// Client.sessions under Node: the auto-bridge layer behind `Client()` and `Client.local()` (src/client/oo.ts),
// against the fake runtime of local.test.ts (tests/fixtures/fake-runtime.mjs).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client, SessionsClient } from "../src/index.js";
import { LocalRuntime, LocalSessionsClient } from "../src/local/index.js";

const FAKE_RUNTIME = fileURLToPath(new URL("./fixtures/fake-runtime.mjs", import.meta.url));
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
    const sessions = client.sessions as unknown as LocalSessionsClient;
    expect(await sessions.bridgedKinds("none")).toEqual([]); // a LocalSessionsClient method, reached once loaded
    expect((await client.sessions.listSessions({ size: 1 }).withRawResponse()).rawResponse.status).toBe(200);
    await client.close(); // stops the sessions it bridged (none); the runtime is not its to stop
    expect(runtime.childAlive).toBe(true);
  });

  // oo.ts taps the loading promise: a broken install surfaces at the first call, not as an unhandled rejection.
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
      await expect(sessions.listSessions()).rejects.toThrow(/broken install/);
    } finally {
      vi.doUnmock("hai-agents/local");
    }
  });

  it("keeps the generated sessions client without auto bridges, and outside Node", () => {
    expect(new Client({ apiKey: "k", autoBridges: false }).sessions).toBeInstanceOf(SessionsClient);
    vi.spyOn(process, "versions", "get").mockReturnValue({} as NodeJS.ProcessVersions);
    expect(new Client({ apiKey: "k" }).sessions).toBeInstanceOf(SessionsClient);
  });
});
