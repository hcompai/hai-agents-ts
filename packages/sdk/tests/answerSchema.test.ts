import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AnswerValidationError,
  attachAnswerSchema,
  runSession,
  waitForSession,
} from "../src/client/polling.js";
import type { HaiAgentsClient } from "../src/client/Client.js";

const Jobs = z.object({
  jobs: z.array(z.object({ title: z.string(), company: z.string() })),
});

const VALID_ANSWER = {
  jobs: [
    { title: "RE", company: "H" },
    { title: "SWE", company: "H" },
  ],
};

function fakeClient(answer: unknown, status = "completed") {
  const createdWith: Record<string, unknown>[] = [];
  const client = {
    sessions: {
      createSession: async (request: Record<string, unknown>) => {
        createdWith.push(request);
        return { id: "sess_1" };
      },
      getSessionStatus: async () => ({ status }),
      getSessionChanges: async () => ({ answer, newEvents: [] }),
    },
  } as unknown as HaiAgentsClient;
  return { client, createdWith };
}

describe("attachAnswerSchema", () => {
  it("injects answerFormat on inline agents, with a title", async () => {
    const params = await attachAnswerSchema({ agent: { name: "a" } } as never, Jobs);
    const agent = params.agent as { answerFormat: Record<string, unknown> };
    expect(agent.answerFormat.title).toBe("Answer");
    expect(agent.answerFormat.type).toBe("object");
  });

  it("injects via overrides for catalog agent strings, preserving user overrides", async () => {
    const params = await attachAnswerSchema(
      { agent: "h/web-surfer", overrides: { "agent.max_steps": 5 } } as never,
      Jobs,
    );
    expect(params.overrides?.["agent.max_steps"]).toBe(5);
    expect((params.overrides?.["agent.answer_format"] as Record<string, unknown>).type).toBe("object");
  });

  it("rejects conflicts with an explicit answer format", async () => {
    await expect(
      attachAnswerSchema({ agent: { name: "a", answerFormat: { type: "object" } } } as never, Jobs),
    ).rejects.toThrow(/conflicts/);
    await expect(
      attachAnswerSchema({ agent: "h/x", overrides: { "agent.answer_format": {} } } as never, Jobs),
    ).rejects.toThrow(/conflicts/);
  });
});

describe("answer parse-back", () => {
  it("parses a completed answer into the schema type", async () => {
    const { client, createdWith } = fakeClient(VALID_ANSWER);
    const result = await runSession(client, {
      agent: "h/web-surfer",
      messages: "find jobs",
      answerSchema: Jobs,
    });
    expect(result.answer?.jobs[1]?.title).toBe("SWE");
    const body = (createdWith[0] as { body: { overrides: Record<string, unknown> } }).body;
    expect((body.overrides["agent.answer_format"] as Record<string, unknown>).title).toBe("Answer");
  });

  it("parses a completed answer delivered as JSON text", async () => {
    const { client } = fakeClient(JSON.stringify(VALID_ANSWER));
    const result = await waitForSession(client, { id: "sess_1", answerSchema: Jobs });
    expect(result.answer?.jobs[0]?.title).toBe("RE");
  });

  it("throws AnswerValidationError on non-JSON text answers", async () => {
    const { client } = fakeClient("plain text answer");
    const promise = waitForSession(client, { id: "sess_1", answerSchema: Jobs });
    await expect(promise).rejects.toBeInstanceOf(AnswerValidationError);
    await promise.catch((error: AnswerValidationError) => {
      expect(error.raw).toBe("plain text answer");
    });
  });

  it("throws AnswerValidationError with the raw payload on mismatch", async () => {
    const { client } = fakeClient({ jobs: "not-a-list" });
    const promise = waitForSession(client, { id: "sess_1", answerSchema: Jobs });
    await expect(promise).rejects.toBeInstanceOf(AnswerValidationError);
    await promise.catch((error: AnswerValidationError) => {
      expect(error.raw).toEqual({ jobs: "not-a-list" });
    });
  });

  it("passes raw answers through on non-completed statuses", async () => {
    const { client } = fakeClient("cancelled mid-run", "interrupted");
    const result = await waitForSession(client, { id: "sess_1", answerSchema: Jobs });
    expect(result.answer).toBe("cancelled mid-run");
  });

  it("throws AnswerValidationError when a completed answer is missing", async () => {
    const { client } = fakeClient(null);
    const promise = waitForSession(client, { id: "sess_1", answerSchema: Jobs });
    await expect(promise).rejects.toBeInstanceOf(AnswerValidationError);
    await promise.catch((error: AnswerValidationError) => {
      expect(error.raw).toBeNull();
    });
  });

  it("passes null answers through on non-completed statuses", async () => {
    const { client } = fakeClient(null, "failed");
    const result = await waitForSession(client, { id: "sess_1", answerSchema: Jobs });
    expect(result.answer).toBeNull();
  });

  it("keeps the raw answer when no schema is given", async () => {
    const { client } = fakeClient(VALID_ANSWER);
    const result = await waitForSession(client, { id: "sess_1" });
    expect(result.answer).toEqual(VALID_ANSWER);
  });
});
