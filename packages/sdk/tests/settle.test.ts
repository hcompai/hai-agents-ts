import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { HaiAgentsClient } from "../src/client/Client.js";
import { SessionHandle, runSession, waitForSession } from "../src/client/polling.js";
import { HaiAgentsTimeoutError, SessionTimeoutError } from "../src/index.js";

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
  it("skips only the hold it just decided", async () => {
    const steps = [0, 0, 1];
    const read: number[] = [];
    const client = {
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
    const handle = new SessionHandle(client, "s1");
    await handle.waitForCompletion({ waitForSeconds: 0 });
    await handle.approve("call_1");
    await handle.waitForCompletion({ waitForSeconds: 0 });
    expect(read).toEqual([0, 0, 1]);
  });
});

describe("SessionHandle cursor", () => {
  it("resumes each turn from where the last wait or stream stopped", async () => {
    const log: { type: string; data: { name: string } }[] = [];
    const append = (...names: string[]) => log.push(...names.map((name) => ({ type: "MessageEvent", data: { name } })));
    const client = {
      sessions: {
        getSessionChanges: async ({ fromIndex, waitForSeconds }: { fromIndex: number; waitForSeconds: number }) => {
          if (fromIndex < log.length) return { newEvents: log.slice(fromIndex), firstIndex: fromIndex, answer: null };
          expect(waitForSeconds, "long-polled past the end of a settled session").toBe(0);
          return undefined;
        },
        getSessionStatus: async () => ({ status: "idle" }),
      },
    } as unknown as HaiAgentsClient;
    const handle = new SessionHandle(client, "s1");
    const names = (events: { data: unknown }[]) => events.map((event) => (event.data as { name: string }).name);

    append("turn1-a", "turn1-b");
    expect(names((await handle.waitForCompletion()).events)).toEqual(["turn1-a", "turn1-b"]);
    append("turn2");
    const streamed = [];
    for await (const event of handle.stream()) streamed.push(event);
    expect(names(streamed)).toEqual(["turn2"]);
    expect((await handle.waitForCompletion()).events).toEqual([]);
    append("turn3");
    expect(names((await handle.waitForCompletion()).events)).toEqual(["turn3"]);
    expect(names((await handle.waitForCompletion({ fromIndex: 0 })).events)).toEqual([
      "turn1-a",
      "turn1-b",
      "turn2",
      "turn3",
    ]);
  });
});

describe("runSession timeout", () => {
  it("names the still-running session", async () => {
    const client = {
      sessions: {
        createSession: async () => ({ id: "s1" }),
        getSessionChanges: async () => undefined,
        getSessionStatus: async () => ({ status: "running" }),
      },
    } as unknown as HaiAgentsClient;
    const error = await runSession(client, { agent: "h/web-surfer-pro", messages: "hi", timeoutMs: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(SessionTimeoutError);
    expect(error).toBeInstanceOf(HaiAgentsTimeoutError);
    expect(error.sessionId).toBe("s1");
    expect(error.nextFromIndex).toBe(0);
  });
});
