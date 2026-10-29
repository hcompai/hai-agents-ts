import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serialization } from "../src/client/index.js";

// The API discriminates several tagged unions on a constant field (Browser.kind, event type
// tags). The spec declares those fields with const+default, but the Fern generator drops the
// default, the serializer omits the field, and the server 422s on union discrimination. The
// codegen pipeline restores the defaults post-generation; these tests fail loudly if a future
// regeneration ships without them.
//
// A schema the spec only ever references as a tagged-union member loses the field altogether;
// the union serializer writes the tag from the parsed value instead.

const spec = JSON.parse(readFileSync(join(__dirname, "../../../openapi.json"), "utf-8"));

const MINIMAL_PARSED: Record<string, object> = {
    Browser: { id: "browser" },
    Desktop: { id: "desktop", host: "user_device" },
    Android: { id: "phone" },
    OnePasswordConfig: { opVaultId: "vault_1" },
    ToolResultEvent: { toolReq: { toolName: "click" }, result: "ok" },
    UserMessageEvent: { message: "hi" },
    ErrorEvent: { error: "boom", origin: "loop" },
    ToolResultBatch: { results: [] },
    UserMessageBatch: { messages: [] },
    AnswerEvent: { answer: "done" },
    FlowEvent: { flow: "step", origin: "loop" },
    MessageEvent: { callerId: "agent" },
    CronTiming: { expression: "0 9 * * *", timezone: "Europe/Paris" },
    Workstation: { id: "workstation" },
};

function specConstDefaults(): [string, string, string][] {
    const cases: [string, string, string][] = [];
    for (const [schemaName, schema] of Object.entries<any>(spec.components.schemas)) {
        for (const [propName, prop] of Object.entries<any>(schema.properties ?? {})) {
            if (prop != null && typeof prop === "object" && "const" in prop && "default" in prop) {
                cases.push([schemaName, propName, prop.default]);
            }
        }
    }
    return cases;
}

/** `Schema.tag` keys for schemas the spec references only as members of a tagged union. */
function unionOnlyTags(): Set<string> {
    const tags = new Map<string, Set<string>>();
    const standalone = new Set<string>();
    const walk = (node: any, tag?: string): void => {
        if (Array.isArray(node)) {
            node.forEach((item) => walk(item));
            return;
        }
        if (node == null || typeof node !== "object") return;
        if (typeof node.$ref === "string") {
            const name = node.$ref.split("/").pop();
            if (tag) tags.set(name, (tags.get(name) ?? new Set()).add(tag));
            else standalone.add(name);
        }
        const discriminator = node.discriminator;
        for (const [key, value] of Object.entries<any>(node)) {
            if ((key === "oneOf" || key === "anyOf") && discriminator?.propertyName) {
                value.forEach((member: any) => walk(member, discriminator.propertyName));
            } else if (key !== "discriminator") {
                walk(value);
            }
        }
    };
    walk(spec);
    const out = new Set<string>();
    for (const [name, names] of tags) {
        if (!standalone.has(name)) names.forEach((tag) => out.add(`${name}.${tag}`));
    }
    return out;
}

describe("spec const+default discriminators", () => {
    it("spec still declares the known discriminator defaults", () => {
        const found = new Set(specConstDefaults().map(([s, p]) => `${s}.${p}`));
        expect(found).toContain("Browser.kind");
        expect(found).toContain("OnePasswordConfig.provider");
    });

    it.each(specConstDefaults())("%s.%s serializes to %s when omitted", (schemaName, propName, expectedDefault) => {
        const schema = (serialization as Record<string, any>)[schemaName];
        expect(schema, `no serializer exported for ${schemaName}`).toBeDefined();
        const raw = schema.jsonOrThrow(MINIMAL_PARSED[schemaName] ?? {});
        if (raw[propName] === undefined) {
            expect(
                unionOnlyTags(),
                `${schemaName}.${propName} is dropped, but the spec also sends ${schemaName} outside a tagged union`,
            ).toContain(`${schemaName}.${propName}`);
            return;
        }
        expect(raw[propName]).toBe(expectedDefault);
    });

    it("keeps kind on the wire through the inline-agent environments path", () => {
        const web = serialization.AgentEnvironmentsItem.jsonOrThrow({ kind: "web", id: "browser" });
        expect((web as any).kind).toBe("web");
        const desktop = serialization.AgentEnvironmentsItem.jsonOrThrow({
            kind: "desktop",
            id: "desktop",
            host: "user_device",
        });
        expect((desktop as any).kind).toBe("desktop");
        const android = serialization.AgentEnvironmentsItem.jsonOrThrow({ kind: "android", id: "phone" });
        expect((android as any).kind).toBe("android");
    });

    it("keeps provider on the wire through the vault create path", () => {
        const onepassword = serialization.VaultCreateRequest.jsonOrThrow({
            name: "vault",
            providerConfig: { provider: "onepassword", opVaultId: "vault_1" },
        });
        expect((onepassword as any).provider_config.provider).toBe("onepassword");
        const internal = serialization.VaultCreateRequest.jsonOrThrow({
            name: "vault",
            providerConfig: { provider: "internal" },
        });
        expect((internal as any).provider_config.provider).toBe("internal");
    });
});
