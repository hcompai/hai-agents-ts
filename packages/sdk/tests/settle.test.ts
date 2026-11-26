import { describe, expect, it } from "vitest";

import type { HaiAgentsClient } from "../src/client/Client.js";
import { SessionHandle, runSession } from "../src/client/polling.js";
import { HaiAgentsTimeoutError, SessionTimeoutError } from "../src/index.js";

// The settle-on-idle cases live in tests/python-mirror/settle.test.ts; these are TypeScript-only.

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

  it("returns on retry the events a timed-out wait read", async () => {
    const log = [{ type: "MessageEvent", data: { name: "read-before-timeout" } }];
    let status = "running";
    const client = {
      sessions: {
        getSessionChanges: async ({ fromIndex }: { fromIndex: number }) =>
          fromIndex < log.length ? { newEvents: log.slice(fromIndex), firstIndex: fromIndex, answer: null } : undefined,
        getSessionStatus: async () => ({ status }),
      },
    } as unknown as HaiAgentsClient;
    const handle = new SessionHandle(client, "s1");

    await expect(handle.waitForCompletion({ maxPolls: 1 })).rejects.toBeInstanceOf(SessionTimeoutError);
    log.push({ type: "MessageEvent", data: { name: "after-timeout" } });
    status = "idle";
    const { events } = await handle.waitForCompletion();
    expect(events.map((event) => (event.data as { name: string }).name)).toEqual(["read-before-timeout", "after-timeout"]);
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
  });
});
