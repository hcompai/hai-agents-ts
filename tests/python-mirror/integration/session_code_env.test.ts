/**
 * Run a one-shot session with a code environment and verify the answer.
 *
 * Why a math question: the answer is unambiguous, the model finishes in 1-2
 * steps, and we can pattern-match the result string. The session cost stays well
 * under a cent.
 */
import { describe, expect, it } from "vitest";

import type { Client, HaiAgents } from "hai-agents";

import { sleep } from "../helpers";
import { client, createdSessions, runId, skipReason } from "./fixtures";

const TERMINAL = new Set(["completed", "failed", "timed_out", "interrupted", "idle"]);
// A freshly-created session can briefly report idle/steps=0 before the first
// step (backend race); only treat idle/completed as terminal once it progressed.
const _PROGRESS_REQUIRED = new Set(["idle", "completed"]);

async function _pollUntilTerminal(client: Client, sessionId: string, timeoutS = 180.0): Promise<HaiAgents.SessionStatus> {
  const start = Date.now() / 1000;
  for (;;) {
    const s = await client.sessions.getSessionStatus({ id: sessionId });
    const status = String(s.status);
    const progressed = (s.steps ?? 0) >= 1 || s.error != null;
    if (TERMINAL.has(status) && (!_PROGRESS_REQUIRED.has(status) || progressed)) return s;
    if (Date.now() / 1000 - start > timeoutS) {
      throw new Error(
        `session ${sessionId} did not reach a terminal status in ${timeoutS}s (last status: ${s.status}, steps: ${s.steps})`,
      );
    }
    await sleep(2);
  }
}

// pytestmark = pytest.mark.integration
describe.skipIf(skipReason() !== null)("integration", () => {
  it("code env math session", async () => {
    const c = client();
    const sessions = createdSessions(c);
    const session = await c.sessions.createSession({
      body: {
        agent: {
          name: `${runId()}-agent`,
          description: "Integration test agent",
          instructions: "You are a minimalist assistant. Reply briefly with just the requested number.",
          environments: [{ id: "code", kind: "code" } as never],
        },
        messages: [{ type: "user_message", message: "What is 17 + 25? Reply with just the number." }],
        maxSteps: 8,
        maxTimeS: 120.0,
        idleTimeoutS: 30,
      },
    });
    sessions.push(session.id);

    const final = await _pollUntilTerminal(c, session.id);
    expect(["completed", "idle"], `session ended in ${final.status}; error=${final.error}`).toContain(String(final.status));
    expect(final.steps ?? 0, "agent ended without taking any steps").toBeGreaterThanOrEqual(1);
    expect(final.error ?? null).toBeNull();

    const changes = await c.sessions.getSessionChanges({ id: session.id });
    const answer = changes?.answer;
    expect(answer ?? null, "no answer in /changes response").not.toBeNull();
    const answerStr = typeof answer === "string" ? answer : JSON.stringify(answer);
    expect(/\b42\b/.test(answerStr), `agent did not return 42; full answer: ${JSON.stringify(answerStr)}`).toBe(true);

    const eventsPage = await c.sessions.listSessionEvents({ id: session.id });
    expect(eventsPage.items.length).toBeGreaterThan(0);
    const eventTypes = new Set(eventsPage.items.map((ev) => ev.type));
    expect(eventTypes.has("AgentEvent"), `no AgentEvent in events feed; saw: ${[...eventTypes].sort()}`).toBe(true);
  }, 240_000);
});
