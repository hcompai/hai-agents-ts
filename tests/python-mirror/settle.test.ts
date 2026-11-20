/** Polling stops when a session settles: terminal, or idle awaiting the next message. */
import { expect, it } from "vitest";
import { z } from "zod";

import { waitForSession } from "hai-agents";

class _Sessions {
  private statuses: string[];
  private answer: unknown;

  constructor(statuses: string[], answer: unknown = null) {
    this.statuses = [...statuses];
    this.answer = answer;
  }

  getSessionChanges(_request: { id: string; fromIndex?: number; limit?: number | null; includeEvents?: boolean; waitForSeconds?: number }) {
    return { newEvents: [], answer: this.answer };
  }

  getSessionStatus(_request: { id: string }) {
    return { status: this.statuses.shift()!, outcome: null, error: null, errorCode: null };
  }
}

it("wait stops on idle and returns answer", async () => {
  const client = { sessions: new _Sessions(["running", "idle"], "done") };
  const result = await waitForSession(client as never, { id: "sess_1", waitForSeconds: 0 });
  expect(result.status).toBe("idle");
  expect(result.answer).toBe("done");
});

const _Answer = z.object({ text: z.string() });

it("idle answer parses into schema", async () => {
  const client = { sessions: new _Sessions(["idle"], '{"text": "hi"}') };
  const result = await waitForSession(client as never, { id: "sess_1", waitForSeconds: 0, answerSchema: _Answer });
  expect(result.answer).toEqual({ text: "hi" });
});

it("idle without answer returns none despite schema", async () => {
  const client = { sessions: new _Sessions(["idle"], null) };
  const result = await waitForSession(client as never, { id: "sess_1", waitForSeconds: 0, answerSchema: _Answer });
  expect(result.answer).toBeUndefined();
});
