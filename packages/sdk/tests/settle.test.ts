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
  // Holds call_1 at step 0 until the agent picks up its decision, then a later step holds the same id.
  function heldClient(read: number[]): HaiAgentsClient {
    const steps = [0, 0, 1];
    return {
      fetch: async () => ({ status: 202 }),
      sessions: {
        getSessionChanges: async () => undefined,
        getSessionStatus: async () => {
          read.push(steps.shift()!);
          return {
            status: "awaiting_tool_results",
            steps: read.at(-1),
            pendingApprovals: [{ toolReq: { id: "call_1", toolName: "shell" }, requirements: [] }],
          };
        },
      },
    } as unknown as HaiAgentsClient;
  }

  it("skips only the hold it just decided", async () => {
    const read: number[] = [];
    const handle = new SessionHandle(heldClient(read), "s1");
    await handle.waitForCompletion({ waitForSeconds: 0 });
    await handle.approve("call_1");
    await handle.waitForCompletion({ waitForSeconds: 0 });
    expect(read).toEqual([0, 0, 1]);
  });

  it("lets a decision made before any wait lapse once a later step holds the call", async () => {
    const read: number[] = [];
    const handle = new SessionHandle(heldClient(read), "s1");
    await handle.deny("call_1");
    await handle.waitForCompletion({ waitForSeconds: 0 });
    expect(read).toEqual([0, 0, 1]);
  });
});
