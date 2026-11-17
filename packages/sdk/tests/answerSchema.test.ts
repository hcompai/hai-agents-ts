import { describe, expect, it } from "vitest";
import { z } from "zod";

import { attachAnswerSchema } from "../src/client/polling.js";

// A pydantic model has a class name for the schema title; a zod schema may have none, so the
// SDK falls back to "Answer" (sagent resolves the answer model by title).
describe("attachAnswerSchema", () => {
  it("injects answerFormat on inline agents, with a title", async () => {
    const Jobs = z.object({ jobs: z.array(z.object({ title: z.string(), company: z.string() })) });
    const params = await attachAnswerSchema({ agent: { name: "a" } } as never, Jobs);
    const agent = params.agent as { answerFormat: Record<string, unknown> };
    expect(agent.answerFormat.title).toBe("Answer");
    expect(agent.answerFormat.type).toBe("object");
  });
});
