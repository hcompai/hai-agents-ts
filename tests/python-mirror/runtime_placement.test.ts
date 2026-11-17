/** Placement boundaries: authentication, compatibility and executor ownership. */
import * as net from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Client } from "hai-agents";
import { BinaryIncompatibleError, Inference, LocalRuntime, LocalRuntimeError, defaultPort } from "hai-agents/local";
import { servedInference } from "hai-agents-src/local/inference";
import { DEFAULT_PORT, inferenceFilePath, tokenFilePath, writeOwnerOnly } from "hai-agents-src/local/state";

import { SDK_ROOT, mp, raisesAsync, readText, tmpPath } from "./helpers";
import { FakeRuntime, RuntimeServer } from "./runtime_fakes";

// The launcher tests' stand-in for the hai-agent-runtime binary, started like the real one, from env.
const FAKE_RUNTIME = [process.execPath, `${SDK_ROOT}/packages/sdk/tests/fixtures/fake-runtime.mjs`];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// runtime_server fixture
let runtimeServer: RuntimeServer;

beforeEach(async () => {
  mp.delenv("HAI_AGENT_RUNTIME_API_TOKEN", { raising: false });
  mp.delenv("HAI_AGENT_LOCAL_BASE_URL", { raising: false });
  mp.delenv("HAI_AGENT_RUNTIME_PORT", { raising: false });
  runtimeServer = await RuntimeServer.start("local-token");
});

afterEach(async () => {
  await runtimeServer.close();
});

it("self hosted inference does not receive hosted key", () => {
  mp.setenv("HAI_API_KEY", "hosted-secret");
  const env = Inference.selfHosted("http://127.0.0.1:8000/v1", "my-model").runtimeEnv(process.env);
  expect("HAI_API_KEY" in env).toBe(false);
  expect(env.HAI_AGENT_RUNTIME_MODEL).toBe("my-model");
  mp.setenv("HAI_AGENT_RUNTIME_BASE_URL", "http://localhost:8000/v1");
  expect("HAI_AGENT_RUNTIME_BASE_URL" in Inference.cloud().runtimeEnv(process.env)).toBe(false);
});

// Python's first row forwards the key `hai login` stored; TS has no credentials store, so the shell's key stands in.
// Python patches ensure_started and reads spawn_env; the TS runtime layer builds that env, so the spawned fake runtime reports it.
it.each([
  [null, null, "hk-shell"],
  [Inference.selfHosted("http://127.0.0.1:8000/v1", "my-model"), null, undefined],
  [null, "http://127.0.0.1:8000/v1", undefined],
])("spawned runtime infers with the key hai login stored [%s, %s, %s]", async (inference, serverEnv, forwarded) => {
  const tmp = tmpPath();
  mp.setenv("HAI_API_KEY", "hk-shell");
  if (serverEnv) {
    mp.setenv("HAI_AGENT_RUNTIME_BASE_URL", serverEnv);
  }
  mp.setenv("HAI_AGENT_RUNTIME_PORT", String(await freePort()));
  const client = await Client.local({ command: FAKE_RUNTIME, cacheDir: tmp, inference: inference ?? undefined });
  try {
    const runtime = client.localRuntime!;
    const env = await runtime.fetch(`${runtime.baseUrl}/fake/env`, { headers: { Authorization: `Bearer ${runtime.apiKey}` } }).then((r) => r.json());
    expect(env.HAI_API_KEY).toBe(forwarded);
    expect(env.HAI_AGENT_RUNTIME_BASE_URL).toBe(inference?.baseUrl ?? serverEnv ?? undefined);
  } finally {
    await client.close();
  }
});

it("runtimes for different inference never share", async () => {
  const tmp = tmpPath();
  const selfHostedEnv = Inference.selfHosted("http://127.0.0.1:8000/v1", "my-model").runtimeEnv({});
  const hosted = servedInference({});
  const selfHosted = servedInference(selfHostedEnv);
  expect(defaultPort(hosted)).toBe(DEFAULT_PORT);
  expect(defaultPort(selfHosted)).not.toBe(DEFAULT_PORT);

  writeOwnerOnly(tokenFilePath(runtimeServer.port, tmp), "local-token");
  writeOwnerOnly(inferenceFilePath(runtimeServer.port, tmp), `${hosted}\n123`);
  const start = { cacheDir: tmp, port: runtimeServer.port, inheritEnv: false };
  await raisesAsync(
    () => LocalRuntime.ensureStarted({ env: selfHostedEnv as Record<string, string>, ...start }),
    LocalRuntimeError,
    /infers against hosted/,
  );
  expect((await LocalRuntime.ensureStarted({ env: {}, ...start })).serves).toBe(hosted);
});

it.each(["local-token", "squatter-token", null])("only the runtime holding the token ever receives it [proof=%s]", async (proofToken) => {
  const tmp = tmpPath();
  writeOwnerOnly(tokenFilePath(runtimeServer.port, tmp), "local-token");
  runtimeServer.proofToken = proofToken;
  if (proofToken !== "local-token") {
    await raisesAsync(() => LocalRuntime.attach({ port: runtimeServer.port, cacheDir: tmp }), LocalRuntimeError, /did not prove/);
    expect(runtimeServer.requests.length).toBeGreaterThan(0);
    expect(runtimeServer.requests.some((seen) => seen.has("authorization"))).toBe(false);
    return;
  }
  const attached = await LocalRuntime.attach({ port: runtimeServer.port, cacheDir: tmp });
  await raisesAsync(() => attached!.requireRecipe("desktop"), BinaryIncompatibleError);
  await raisesAsync(() => attached!.shutdown(), LocalRuntimeError);
  const client = await Client.local({ runtime: attached! });
  try {
    expect((await client.sessions.listSessions({})).items).toEqual([]);
    runtimeServer.proofToken = "squatter-token";
    await raisesAsync(() => client.sessions.listSessions({}), Error, /did not prove/);
  } finally {
    await client.close();
  }
});

it.each(["https://remote.example", "http://user:pass@localhost:80"])("local attach rejects remote or credential urls [%s]", async (url) => {
  const tmp = tmpPath();
  mp.setenv("HAI_AGENT_LOCAL_BASE_URL", url);
  await raisesAsync(() => LocalRuntime.attach({ cacheDir: tmp }), LocalRuntimeError, /loopback/);
});

it("spawner never overwrites the live runtime token", async () => {
  const tmp = tmpPath();
  const tokenFile = writeOwnerOnly(tokenFilePath(runtimeServer.port, tmp), runtimeServer.token);
  // The port is held by a server that cannot prove it is our runtime (Python patches `_attach` out instead).
  runtimeServer.proofToken = "squatter-token";
  await raisesAsync(
    () =>
      LocalRuntime.ensureStarted({
        command: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
        cacheDir: tmp,
        port: runtimeServer.port,
        timeoutMs: 5000,
      }),
    LocalRuntimeError,
    /did not prove/,
  );
  expect(readText(tokenFile)).toBe(runtimeServer.token);
});

it("attached runtime with another recipe is rejected and left running", async () => {
  class Runtime extends FakeRuntime {
    override async requireRecipe(): Promise<void> {
      throw new BinaryIncompatibleError("recipe changed");
    }
  }

  const runtime = new Runtime();
  await raisesAsync(() => Client.local({ runtime: runtime as never }), BinaryIncompatibleError, /recipe changed/);
  expect(runtime.stopped).toBe(false);
});

