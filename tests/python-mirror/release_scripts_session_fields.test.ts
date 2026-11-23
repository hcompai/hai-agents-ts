/** test_release_scripts.py's runtime check: a release refuses session fields the pinned runtime does not accept (scripts/release.mjs, ts-local-launcher). */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { SDK_ROOT } from "./helpers";

type Spec = { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };

interface Release {
  unacceptedSessionFields(sdk: Spec, runtime: Spec): string[];
}

// runpy.run_path(...), as in release_scripts.test.ts.
const checkRelease = (await import(pathToFileURL(path.join(SDK_ROOT, "scripts", "release.mjs")).href)) as Release;

function _spec(paths: Record<string, unknown>, schemas: Record<string, unknown> | null = null): Spec {
  return { paths, components: { schemas: schemas ?? {} } };
}

function _post(schema: Record<string, unknown>) {
  return { post: { requestBody: { content: { "application/json": { schema } } } } };
}

it("session fields the runtime does not accept block the release", () => {
  const environment = { properties: { kind: { type: "string" }, settle_s: { type: "number" } } };
  const agent = {
    properties: {
      environments: { type: "array", items: { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Env" }] } },
      subagents: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
    },
  };
  const session = { properties: { agent: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Agent" }] } } };
  const sdk = _spec(
    { "/api/v2/sessions": _post(session), "/api/v2/environments": _post({ $ref: "#/components/schemas/Env" }) },
    { Agent: agent, Env: environment },
  );
  const old_environment = { properties: { kind: { type: "string" } } };
  const runtime = _spec(
    { "/api/v2/sessions": _post(session), "/api/v2/environments": _post({ $ref: "#/components/schemas/Env" }) },
    { Agent: agent, Env: old_environment },
  );

  expect(checkRelease.unacceptedSessionFields(sdk, runtime)).toEqual(["POST /api/v2/sessions: agent.environments[].settle_s"]);
});
