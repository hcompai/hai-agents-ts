/**
 * Browser-environment session against a search engine.
 *
 * The agent is dropped on a search-engine start URL (set on the environment spec)
 * and asked for Paris weather without being told which engine to use. Exercises
 * web browser provisioning, the agent using whatever page it lands on, and
 * end-to-end answer extraction.
 *
 * Bing is used because it can be read without a CAPTCHA. The engine lives in the
 * env spec, not the prompt -- mirroring how a product injects a start URL via config.
 *
 * Marked `slow` (~60-120s, more tokens than the code-env test). Skipped by
 * default; opt in with RUN_SLOW_SDK_TESTS=1.
 */
import { describe, expect, it } from "vitest";

import type { Client, HaiAgents } from "hai-agents";

import { sleep } from "../helpers";
import { client, createdSessions, runId, skipReason } from "./fixtures";

// Engine is a test-level parameter, NOT part of the prompt. To swap engines,
// change this line and leave the prompt alone.
const SEARCH_ENGINE_START_URL = "https://www.bing.com/";

const TERMINAL = new Set(["completed", "failed", "timed_out", "interrupted", "idle"]);

async function _pollUntilTerminal(client: Client, sessionId: string, timeoutS = 420.0): Promise<HaiAgents.SessionStatus> {
  const start = Date.now() / 1000;
  for (;;) {
    const s = await client.sessions.getSessionStatus({ id: sessionId });
    if (TERMINAL.has(String(s.status))) return s;
    if (Date.now() / 1000 - start > timeoutS) {
      throw new Error(`session ${sessionId} did not finish in ${timeoutS}s (last status: ${s.status}, steps: ${s.steps})`);
    }
    await sleep(3);
  }
}

// pytestmark = [integration, slow]
describe.skipIf(skipReason() !== null)("integration slow", () => {
  it.skipIf(!process.env.RUN_SLOW_SDK_TESTS)("browser session finds paris weather", async () => {
    const c = client();
    const sessions = createdSessions(c);
    const session = await c.sessions.createSession({
      body: {
        agent: {
          name: `${runId()}-weather`,
          description: "Integration test browser agent for weather lookup",
          instructions:
            "You navigate the web to answer the user's question. Use the search box on the page you " +
            "land on, search for what you need, and read the result. Reply in a single concise sentence.",
          environments: [
            {
              id: "browser",
              kind: "web",
              mode: { type: "visual", width: 1280, height: 800 },
              startUrl: SEARCH_ENGINE_START_URL,
            },
          ],
        },
        messages: [
          {
            type: "user_message",
            message:
              "What is the current temperature in Paris today? " + "Reply with a short sentence giving the value in degrees Celsius.",
          },
        ],
        maxSteps: 25,
        maxTimeS: 360.0,
        idleTimeoutS: 60,
      },
    });
    sessions.push(session.id);

    const final = await _pollUntilTerminal(c, session.id);
    expect(["completed", "idle"], `session ended in ${final.status}; error=${final.error}`).toContain(String(final.status));
    expect(final.error ?? null).toBeNull();

    const changes = await c.sessions.getSessionChanges({ id: session.id });
    const answer = changes?.answer;
    expect(answer ?? null, "no answer in /changes response").not.toBeNull();
    const answerStr = typeof answer === "string" ? answer : JSON.stringify(answer);

    expect(/paris/i.test(answerStr), `answer doesn't mention Paris: ${JSON.stringify(answerStr)}`).toBe(true);
    expect(
      /-?\d+(?:[.,]\d+)?\s*(?:°|degr(?:e|é|ee)s?|celsius|c\b)/i.test(answerStr),
      `answer doesn't contain a temperature value: ${JSON.stringify(answerStr)}`,
    ).toBe(true);
  }, 500_000);
});
