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

const FIELD_DROPPED_ENTIRELY = new Set([
    "UserMessageBatch.type",
    "AnswerEvent.kind",
    "FlowEvent.kind",
    "MessageEvent.kind",
    "ObservationEvent.kind",
    "PolicyEvent.kind",
    "BrowserVisualMode.type",
    "BrowserTextMode.type",
    // Environment is a kind-discriminated union; the variant serializers drop the tag and the
    // Environment union serializer writes it from the parsed value instead.
    "Browser.kind",
    "Desktop.kind",
]);

const MINIMAL_PARSED: Record<string, object> = {
    Browser: { id: "browser" },
    Desktop: { id: "desktop", host: "user_device" },
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

    it.each([...FIELD_DROPPED_ENTIRELY])("%s stays dropped until a regeneration restores it", (key) => {
        const [schemaName, propName] = key.split(".");
        const schema = (serialization as Record<string, any>)[schemaName];
        const raw = schema.jsonOrThrow(MINIMAL_PARSED[schemaName] ?? {});
        expect(raw[propName], `${key} is back in the serialized output; move it out of FIELD_DROPPED_ENTIRELY`).toBeUndefined();
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
    });
});
