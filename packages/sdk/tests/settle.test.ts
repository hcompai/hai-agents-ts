import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { HaiAgentsClient } from "../src/client/Client.js";
import { SessionHandle, waitForSession } from "../src/client/polling.js";

// Polling stops when a session settles: terminal, or idle awaiting the next message.

function fakeClient(statuses: string[], answer: unknown = null) {
  let changesIdx = 0;
  let statusIdx = 0;
  return {
    sessions: {
      getSessionChanges: async () => ({
        status: statuses[Math.min(changesIdx++, statuses.length - 1)],
        newEvents: [],
        answer,
      }),
      getSessionStatus: async () => ({ status: statuses[Math.min(statusIdx++, statuses.length - 1)] }),
    },
  } as unknown as HaiAgentsClient;
}

describe("waitForSession settling on idle", () => {
  it("stops on idle and returns the answer", async () => {
    const result = await waitForSession(fakeClient(["running", "idle"], "done"), { id: "s1", waitForSeconds: 0 });
    expect(result.status).toBe("idle");
    expect(result.answer).toBe("done");
  });

  it("parses an idle answer into the answerSchema", async () => {
    const schema = z.object({ text: z.string() });
    const result = await waitForSession(fakeClient(["idle"], '{"text":"hi"}'), {
      id: "s1",
      waitForSeconds: 0,
      answerSchema: schema,
    });
    expect(result.answer).toEqual({ text: "hi" });
  });

  it("returns undefined when idle has no answer despite a schema", async () => {
    const schema = z.object({ text: z.string() });
    const result = await waitForSession(fakeClient(["idle"], null), {
      id: "s1",
      waitForSeconds: 0,
      answerSchema: schema,
    });
    expect(result.answer).toBeUndefined();
  });
});

describe("SessionHandle waiting after a decision", () => {
  it("skips the hold it just decided", async () => {
    const holds = [["call_1"], ["call_2"]];
    const client = {
      fetch: async () => ({ status: 202 }),
      sessions: {
        getSessionChanges: async () => undefined,
        getSessionStatus: async () => ({
          status: "awaiting_tool_results",
          pendingApprovals: (holds.shift() ?? []).map((id) => ({
            toolReq: { id, toolName: "shell" },
            requirements: [],
          })),
        }),
      },
    } as unknown as HaiAgentsClient;
    const handle = new SessionHandle(client, "s1");
    await handle.approve("call_1");
    const result = await handle.waitForCompletion({ waitForSeconds: 0 });
    expect(result.pendingApprovals.map((request) => request.toolReq.id)).toEqual(["call_2"]);
  });
});
