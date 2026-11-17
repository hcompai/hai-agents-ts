import { describe, expect, it } from "vitest";

import { serialization } from "../src/client/index.js";

// The tag of a tagged-union member is hand-restored in the TS serializers, so a parent dropping
// its child's tag is a TS-only failure (Python's variant classes carry the tag themselves).
describe("spec const+default discriminators", () => {
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
