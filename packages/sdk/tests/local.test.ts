import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HaiAgentsClient, LocalRuntimeError } from "../src/local/index.js";
import { resolveBinary } from "../src/local/install.js";

const FAKE = fileURLToPath(new URL("./fixtures/fakeRuntime.mjs", import.meta.url));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => chmodSync(FAKE, 0o755));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("HaiAgentsClient.local", () => {
  it("talks to the runtime it started and stops it once only its own sessions remain", async () => {
    const client = await HaiAgentsClient.local({ binaryPath: FAKE });
    const { pid, owned } = client.runtime!;
    expect(owned).toBe(true);

    await client.sessions.createSession({ body: { agent: "my-agent" } });
    await client.close();

    expect(alive(pid)).toBe(false);
  });

  it("keeps the runtime alive while another client's session is active", async () => {
    const client = await HaiAgentsClient.local({ binaryPath: FAKE, env: { FAKE_FOREIGN_SESSION: "1" } });
    const { pid } = client.runtime!;

    await client.close();

    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGTERM");
  });

  it("rejects a server that cannot prove it holds the runtime token", async () => {
    const client = await HaiAgentsClient.local({ binaryPath: FAKE, env: { FAKE_UNPROVEN: "1" } });

    await expect(client.sessions.listSessions()).rejects.toMatchObject({ cause: expect.any(LocalRuntimeError) });
    process.kill(client.runtime!.pid, "SIGTERM");
  });

  it("surfaces why the runtime exited without a handle", async () => {
    await expect(
      HaiAgentsClient.local({ binaryPath: FAKE, env: { FAKE_FAIL: "port 18795 serves recipe 'desktop', not 'shared'" } }),
    ).rejects.toThrow(/serves recipe 'desktop'/);
  });
});

describe("runtime download", () => {
  it("refuses an artifact whose sha256 does not match and installs nothing", async () => {
    const server = createServer((_req, res) => res.end("tampered"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const cache = mkdtempSync(join(tmpdir(), "hai-local-"));
    vi.stubEnv("PATH", "");
    vi.stubEnv("HAI_AGENT_LOCAL_CACHE_DIR", cache);
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}/rt.zip`);
    vi.stubEnv("HAI_AGENT_RUNTIME_DOWNLOAD_SHA256", "0".repeat(64));

    await expect(resolveBinary({})).rejects.toThrow(/sha256 verification/);
    server.close();

    expect(existsSync(join(cache, "bin", "0.1.21"))).toBe(false);
  });
});
