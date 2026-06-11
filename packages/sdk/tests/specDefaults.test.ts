import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serialization } from "../src/client/index.js";

// The API discriminates several tagged unions on a constant field (Browser.kind, event type
// tags). The spec declares those fields with const+default, but the Fern generator drops the
// default, the serializer omits the field, and the server 422s on union discrimination. The
// codegen pipeline restores the defaults post-generation; these tests fail loudly if a future
// regeneration ships without them.

const spec = JSON.parse(readFileSync(join(__dirname, "../../../openapi.json"), "utf-8"));

// Tag carried by the per-endpoint request-body wrappers instead of the model itself.
const FIELD_DROPPED_ENTIRELY = new Set(["ToolResultBatch.type", "UserMessageBatch.type"]);

const MINIMAL_PARSED: Record<string, object> = {
    Browser: { id: "browser" },
    OnePasswordConfig: { opVaultId: "vault_1" },
    ToolResultEvent: { toolCallId: "call_1", result: "ok" },
    UserMessageEvent: { message: "hi" },
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

describe("spec const+default discriminators", () => {
    it("spec still declares the known discriminator defaults", () => {
        const found = new Set(specConstDefaults().map(([s, p]) => `${s}.${p}`));
        expect(found).toContain("Browser.kind");
        expect(found).toContain("OnePasswordConfig.provider");
    });

    it.each(specConstDefaults().filter(([s, p]) => !FIELD_DROPPED_ENTIRELY.has(`${s}.${p}`)))(
        "%s.%s serializes to %s when omitted",
        (schemaName, propName, expectedDefault) => {
            const schema = (serialization as Record<string, any>)[schemaName];
            expect(schema, `no serializer exported for ${schemaName}`).toBeDefined();
            const raw = schema.jsonOrThrow(MINIMAL_PARSED[schemaName] ?? {});
            expect(raw[propName]).toBe(expectedDefault);
        },
    );

    it("injects kind through the inline-agent environments path", () => {
        const raw = serialization.AgentEnvironmentsItem.jsonOrThrow({ id: "browser" });
        expect((raw as any).kind).toBe("web");
    });
});
