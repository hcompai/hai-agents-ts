/**
 * test_answer_schema.py's TestSchemaInjection::test_non_pydantic_schema_rejected: the zod guard of
 * `attachAnswerSchema` is in the platform's overlay (polling.ts). Lands with the platform's client sync.
 */
import { describe, it } from "vitest";

// Internal in the TS SDK (Python exports it as a private helper from hai_agents.polling).
import { attachAnswerSchema } from "hai-agents-src/client/polling";

import { raisesAsync } from "./helpers";

describe("SchemaInjection", () => {
  it("non zod schema rejected", async () => {
    await raisesAsync(() => attachAnswerSchema({ agent: "h/web-surfer-pro" }, { parse: (data: unknown) => data }), TypeError, /zod/);
  });
});
