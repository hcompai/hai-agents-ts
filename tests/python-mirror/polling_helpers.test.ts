/**
 * Unit tests for polling guards: settled vs terminal, payload size, wait timeouts.
 *
 * `waitForSession` already has idle/schema coverage in `settle.test.ts`. These
 * tests lock the remaining public helpers without changing the implementation.
 */
import { expect, it } from "vitest";
import { z } from "zod";

import {
  HaiAgentsTimeoutError,
  assertRequestUnderLimit,
  isSettledSessionStatus,
  isTerminalSessionStatus,
  waitForSession,
} from "hai-agents";

import { raisesAsync } from "./helpers";

const TERMINAL = ["completed", "failed", "timed_out", "interrupted"] as const;
const IN_FLIGHT = ["queued", "pending", "running", "paused", "awaiting_tool_results"] as const;

class _AlwaysRunning {
  getSessionChanges(_request: object) {
    return { newEvents: [], answer: null };
  }

  getSessionStatus(_request: object) {
    return { status: "running", outcome: null, error: null, errorCode: null };
  }
}

class _Sessions {
  private statuses: string[];

  constructor(statuses: string[]) {
    this.statuses = [...statuses];
  }

  getSessionChanges(_request: object) {
    return { newEvents: [], answer: "done" };
  }

  getSessionStatus(_request: object) {
    return { status: this.statuses.shift()!, outcome: null, error: null, errorCode: null };
  }
}

it.each(TERMINAL)("terminal statuses are settled and terminal [%s]", (status) => {
  expect(isTerminalSessionStatus(status)).toBe(true);
  expect(isSettledSessionStatus(status)).toBe(true);
});

it("idle is settled but not terminal", () => {
  expect(isTerminalSessionStatus("idle")).toBe(false);
  expect(isSettledSessionStatus("idle")).toBe(true);
});

it.each(IN_FLIGHT)("in flight statuses are neither settled nor terminal [%s]", (status) => {
  expect(isTerminalSessionStatus(status as never)).toBe(false);
  expect(isSettledSessionStatus(status as never)).toBe(false);
});

it("payload under limit is accepted", () => {
  const payload = { agent: "h/web-surfer-pro", messages: "hello" };
  assertRequestUnderLimit(payload);
  assertRequestUnderLimit(payload, Buffer.byteLength(JSON.stringify(payload)));
});

it("oversized payload raises before send", () => {
  expect(() => assertRequestUnderLimit({ blob: "x".repeat(200) }, 50)).toThrow(/over the/);
});

it("payload limit serializes pydantic models", () => {
  const Shot = z.object({ png: z.string() });

  assertRequestUnderLimit(Shot.parse({ png: "ok" }), 200);
  expect(() => assertRequestUnderLimit(Shot.parse({ png: "x".repeat(200) }), 50)).toThrow(/Downscale images/);
});

it("wait times out on wall clock", async () => {
  const client = { sessions: new _AlwaysRunning() };
  await raisesAsync(
    () => waitForSession(client as never, { id: "sess_1", waitForSeconds: 0, timeoutMs: 0 }),
    HaiAgentsTimeoutError,
    /did not settle within 0/,
  );
});

it("wait times out when max polls exhausted", async () => {
  const client = { sessions: new _AlwaysRunning() };
  await raisesAsync(
    () => waitForSession(client as never, { id: "sess_1", waitForSeconds: 0, maxPolls: 2 }),
    HaiAgentsTimeoutError,
    /maxPolls=2/,
  );
});

it("wait returns if session settles before max polls", async () => {
  const client = { sessions: new _Sessions(["running", "idle"]) };
  const result = await waitForSession(client as never, { id: "sess_1", waitForSeconds: 0, maxPolls: 3 });
  expect(result.status).toBe("idle");
  expect(result.answer).toBe("done");
});
