/** test_runtime_placement.py's two tests of the runtime hold's auto bridges: they need the bridge layer (ts-local). */
import { afterEach, beforeEach, expect, it } from "vitest";

import { Client, SessionsClient } from "hai-agents";
import { LocalRuntime, LocalRuntimeError } from "hai-agents/local";
import type { AgentLike, ManagedBridge } from "hai-agents/local";
import * as core from "hai-agents-src/client/core/index.js";
import { provenFetch } from "hai-agents-src/local/identity";
import { _defaultManager } from "hai-agents-src/local/manager.js";
import { _localize } from "hai-agents-src/local/sessions.js";

import { mp, raisesAsync } from "./helpers";
import { FakeRuntime, RuntimeServer } from "./runtime_fakes";

// runtime_server fixture, as in runtime_placement.test.ts
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

// Python runs it against its sync and async clients; TS has one. Python's agent carries a desktop environment: a web one here.
it("local client without auto bridges leaves execution to the product", async () => {
  mp.setenv("HAI_AUTO_BRIDGE", "1");
  const served: ManagedBridge[] = [];
  mp.setattr(_defaultManager, "ensure", async (bridges: readonly ManagedBridge[]) => {
    served.push(...bridges);
    return [];
  });
  const requested: { body: Record<string, unknown> }[] = [];
  // Python's fake returns a plain value; the TS client awaits the HttpResponsePromise with `.withRawResponse()`.
  const create = (request: { body: Record<string, unknown> }) => {
    requested.push(request);
    return core.HttpResponsePromise.fromResult({ data: { id: "run" }, rawResponse: core.unknownRawResponse });
  };
  mp.setattr(SessionsClient.prototype, "createSession", create as never);
  const agent = { name: "qa", environments: [{ id: "laptop", kind: "web", host: "user_device" }] };
  const client = await Client.local({ runtime: new FakeRuntime() as never, autoBridges: false });
  try {
    await client.sessions.createSession({ body: { agent: agent as AgentLike as string, messages: "test" } });
  } finally {
    await client.close();
  }
  expect(served).toEqual([]);
  expect(requested[0]!.body.agent).toEqual(agent);
});

// A web environment for Python's workstation one, start() for run(). Python flags verify_runtime on the bridge; here the runtime's proof-checking fetch goes in.
it("bridge never serves an unproven runtime", async () => {
  mp.delenv("HAI_AUTO_BRIDGE", { raising: false });
  runtimeServer.proofToken = "squatter-token";
  const runtime = { apiKey: "local-token", baseUrl: `http://127.0.0.1:${runtimeServer.port}`, fetch: provenFetch("local-token") } as unknown as LocalRuntime;
  const agent = { environments: [{ id: "laptop", kind: "web", host: "user_device" }] };
  const [bridge] = await _localize({}, runtime, { body: { agent: agent as AgentLike as string, messages: "hi" } }, {});
  mp.setattr(bridge!, "createDriver", async () => {
    throw new Error("a driver started for an unproven runtime");
  });
  await raisesAsync(() => bridge!.start(), LocalRuntimeError, /did not prove/);
});
