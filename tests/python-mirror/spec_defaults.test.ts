/**
 * The OpenAPI spec's const+default discriminators must survive into the generated models.
 *
 * The API discriminates several tagged unions on a constant field (the environment `kind`,
 * `OnePasswordConfig.provider`, event `type` tags). The spec declares those fields with both
 * `const` and `default`, but the generator drops the default and the serializer omits the
 * field entirely: the server then rejects the payload with a 422
 * ("Unable to extract tag using discriminator 'kind'") because union discrimination runs before
 * per-variant defaults are applied.
 *
 * A model that the spec only ever references as a tagged-union member loses the field altogether;
 * the union serializer writes the tag from the parsed value instead.
 *
 * These tests pin the hand-restored defaults so a future regeneration that clobbers them fails CI
 * loudly instead of shipping another field-omission 422.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

import { serialization } from "hai-agents";

import { SDK_ROOT } from "./helpers";

const SPEC = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, "openapi.json"), "utf-8"));

const MINIMAL_KWARGS: Record<string, Record<string, unknown>> = {
  Browser: { id: "browser" },
  Desktop: { id: "desktop" },
  Android: { id: "phone" },
  OnePasswordConfig: { opVaultId: "vault_1" },
  ToolResultEvent: { toolReq: { toolName: "click" }, result: "ok" },
  UserMessageEvent: { message: "hi" },
  ErrorEvent: { error: "boom", origin: "loop" },
  ToolResultBatch: { results: [] },
  ToolApprovalBatch: { responses: [] },
  ToolApprovalResponseEvent: { callId: "call_1", action: "approve" },
  UserMessageBatch: { messages: [] },
  AnswerEvent: { answer: "done" },
  FlowEvent: { flow: "step", origin: "loop" },
  MessageEvent: { callerId: "agent" },
  CronTiming: { expression: "0 9 * * *", timezone: "Europe/Paris" },
  Workstation: { id: "workstation" },
};

function _specConstDefaults(): [string, string, unknown][] {
  const cases: [string, string, unknown][] = [];
  for (const [schemaName, schema] of Object.entries<any>(SPEC.components.schemas)) {
    for (const [propName, prop] of Object.entries<any>(schema.properties ?? {})) {
      if (prop && typeof prop === "object" && "const" in prop && "default" in prop) {
        cases.push([schemaName, propName, prop.default]);
      }
    }
  }
  return cases;
}

/** (schema, tag) pairs for schemas the spec references only as members of a tagged union. */
function _unionOnlyTags(): Set<string> {
  const tags = new Map<string, Set<string>>();
  const standalone = new Set<string>();

  function walk(node: unknown, tag: string | null = null): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, any>;
    if ("$ref" in record) {
      const name = String(record.$ref).split("/").at(-1)!;
      if (tag) {
        if (!tags.has(name)) tags.set(name, new Set());
        tags.get(name)!.add(tag);
      } else {
        standalone.add(name);
      }
    }
    const discriminator = record.discriminator;
    for (const [key, value] of Object.entries(record)) {
      if ((key === "oneOf" || key === "anyOf") && discriminator && typeof discriminator === "object") {
        for (const member of value) walk(member, discriminator.propertyName);
      } else if (key !== "discriminator") {
        walk(value);
      }
    }
  }

  walk(SPEC);
  const pairs = new Set<string>();
  for (const [name, namesTags] of tags) {
    if (standalone.has(name)) continue;
    for (const tag of namesTags) pairs.add(`${name}.${tag}`);
  }
  return pairs;
}

it("spec declares the known discriminator defaults", () => {
  // Guard the guard: if the spec stops declaring these, the drift test below would go vacuous.
  const found = new Set(_specConstDefaults().map(([s, p]) => `${s}.${p}`));
  expect(found.has("Browser.kind") && found.has("OnePasswordConfig.provider")).toBe(true);
});

it.each(_specConstDefaults())("generated model sends spec default [%s.%s]", (schemaName, propName, expectedDefault) => {
  const model = (serialization as Record<string, any>)[schemaName];
  expect(model, `no serializer exported for ${schemaName}`).toBeDefined();
  const jsonBody = model.jsonOrThrow(MINIMAL_KWARGS[schemaName] ?? {});
  if (jsonBody[propName] === undefined) {
    expect(
      _unionOnlyTags().has(`${schemaName}.${propName}`),
      `${schemaName}.${propName} is missing from the generated model, but the spec also sends ` +
        `${schemaName} outside a tagged union, so those payloads would omit the tag.`,
    ).toBe(true);
    return;
  }
  expect(
    jsonBody[propName],
    `${schemaName}.${propName} should default to ${JSON.stringify(expectedDefault)} per the OpenAPI spec; ` +
      "a regeneration probably clobbered the hand-restored default (see this file's docstring).",
  ).toEqual(expectedDefault);
});

it.each([
  [serialization.AgentEnvironmentsItem, { kind: "web", id: "browser", startUrl: "https://x.test" }, "kind", "web"],
  [serialization.AgentEnvironmentsItem, { kind: "desktop", id: "box" }, "kind", "desktop"],
  [serialization.AgentEnvironmentsItem, { kind: "android", id: "phone" }, "kind", "android"],
  [serialization.VaultCreateRequestProviderConfig, { provider: "onepassword", opVaultId: "vault_1" }, "provider", "onepassword"],
  [serialization.VaultCreateRequestProviderConfig, { provider: "internal" }, "provider", "internal"],
] as unknown as [{ jsonOrThrow(value: unknown): Record<string, unknown> }, Record<string, unknown>, string, string][])(
  "union variant sends its tag [%o]",
  (model, instance, field, expected) => {
    const jsonBody = model.jsonOrThrow(instance);
    expect(jsonBody[field]).toBe(expected);
  },
);
