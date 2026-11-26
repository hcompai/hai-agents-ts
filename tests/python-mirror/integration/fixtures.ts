/**
 * Fixtures for live integration tests against the Agent Platform API.
 *
 * These tests hit a real backend (staging by default). They are skipped when
 * `HAI_API_KEY_TEST` is unset, so the suite is safe to run anywhere -- CI only
 * exercises them when the secret is wired up.
 *
 * Never point these tests at production. The default base URL is staging, and
 * overriding it via `HAI_API_BASE_URL_TEST` is the deliberate escape hatch.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

import { Client } from "../client";

// load_dotenv(ROOT / ".env", override=False): the repository root, as conftest.py's parents[2]
try {
  const dotenv = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"), "utf-8");
  for (const line of dotenv.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env */
}

export const DEFAULT_BASE_URL = "https://agp.staging.sandboxh.ai";

// IDLE is included: a session waiting for follow-up messages is a stopping point
// for these one-shot tests, not a state to keep polling through.
export const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "interrupted", "idle"]);

/** Why the live suite is skipped, or null when it can run (pytest.skip in `_require_key`). */
export function skipReason(): string | null {
  const key = process.env.HAI_API_KEY_TEST;
  if (!key) {
    return "HAI_API_KEY_TEST is not set -- live integration tests skipped. Set it to a STAGING key (never prod) to run the suite.";
  }
  if (!key.startsWith("hk-")) return "HAI_API_KEY_TEST does not look like a portal-H key (hk-*).";
  return null;
}

function _requireKey(): string {
  const reason = skipReason();
  if (reason) throw new Error(reason);
  return process.env.HAI_API_KEY_TEST!;
}

/** API base URL. Defaults to staging; override with HAI_API_BASE_URL_TEST. */
export function baseUrl(): string {
  return process.env.HAI_API_BASE_URL_TEST ?? DEFAULT_BASE_URL;
}

export function apiKey(): string {
  return _requireKey();
}

/** A fresh client per test (cheap; no connection pool reuse needed). */
export function client(): Client {
  return new Client({ apiKey: apiKey(), baseUrl: baseUrl() });
}

/** Short unique id used to namespace resources created during the test. */
export function runId(): string {
  return `sdkit-${Math.floor(Date.now() / 1000)}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

/** Track skill names created during a test and delete them on teardown (call inside the test). */
export function createdSkills(client: Client): string[] {
  const names: string[] = [];
  onTestFinished(async () => {
    for (const name of names) {
      try {
        await client.skills.deleteSkill({ name });
      } catch (exc) {
        console.log(`warning: cleanup failed for skill ${name}: ${exc}`);
      }
    }
  });
  return names;
}

/** Track session ids and cancel any non-terminal session on teardown (call inside the test). */
export function createdSessions(client: Client): string[] {
  const ids: string[] = [];
  onTestFinished(async () => {
    for (const sid of ids) {
      try {
        const status = await client.sessions.getSessionStatus({ id: sid });
        if (!TERMINAL_STATUSES.has(String(status.status))) await client.sessions.cancelSession({ id: sid });
      } catch (exc) {
        console.log(`warning: cleanup failed for session ${sid}: ${exc}`);
      }
    }
  });
  return ids;
}
