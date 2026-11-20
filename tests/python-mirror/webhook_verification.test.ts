/**
 * Unit tests for `verifyWebhook`: HMAC, replay window, secret rotation, raw body.
 *
 * The helper is a public README surface (PR #94) with no prior coverage. These
 * tests lock the documented contract without changing the implementation.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WebhookVerificationError, verifyWebhook } from "hai-agents";
import type { WebhookEventData } from "hai-agents";
import { DEFAULT_TOLERANCE_S } from "hai-agents-src/client/webhookVerification";

import { raises } from "./helpers";

const SECRET = "whsec_test";
const OLD_SECRET = "whsec_old";
const NEW_SECRET = "whsec_new";
const NOW = 1_700_000_000;
const TIMESTAMP = String(NOW);

const PAYLOAD = {
  type: "session.status_updated",
  id: "evt_1",
  created_at: "2023-11-14T22:13:20Z",
  data: { session_id: "sess_1", status: "idle", previous_status: "running" },
};
const BODY = Buffer.from(JSON.stringify(PAYLOAD));

function _sign(secret: string, timestamp: string, raw: Buffer): string {
  const digest = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest("hex");
  return `sha256=${digest}`;
}

// freeze_time
beforeEach(() => {
  vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("valid hmac parses event", () => {
  const event = verifyWebhook(BODY, _sign(SECRET, TIMESTAMP, BODY), TIMESTAMP, SECRET);
  expect(event.type).toBe("session.status_updated");
  expect(event.id).toBe("evt_1");
  expect(event.data.session_id).toBe("sess_1");
  const typed = event.data as unknown as WebhookEventData;
  expect(typed.status).toBe("idle");
  expect(typed.previous_status).toBe("running");
});

it("str body matches bytes body", () => {
  const rawStr = BODY.toString("utf-8");
  const event = verifyWebhook(rawStr, _sign(SECRET, TIMESTAMP, BODY), TIMESTAMP, SECRET);
  expect(event.id).toBe("evt_1");
});

it("bad hmac is rejected", () => {
  raises(() => verifyWebhook(BODY, _sign("whsec_other", TIMESTAMP, BODY), TIMESTAMP, SECRET), WebhookVerificationError, /signature mismatch/);
});

it("empty signature is rejected", () => {
  raises(() => verifyWebhook(BODY, "", TIMESTAMP, SECRET), WebhookVerificationError, /signature mismatch/);
});

it("replay older than 300s is rejected", () => {
  const stale = String(NOW - DEFAULT_TOLERANCE_S - 1);
  raises(() => verifyWebhook(BODY, _sign(SECRET, stale, BODY), stale, SECRET), WebhookVerificationError, /possible replay/);
});

it("future timestamp beyond 300s is rejected", () => {
  const ahead = String(NOW + DEFAULT_TOLERANCE_S + 1);
  raises(() => verifyWebhook(BODY, _sign(SECRET, ahead, BODY), ahead, SECRET), WebhookVerificationError, /possible replay/);
});

it("timestamp exactly at 300s is accepted", () => {
  const edge = String(NOW - DEFAULT_TOLERANCE_S);
  const event = verifyWebhook(BODY, _sign(SECRET, edge, BODY), edge, SECRET);
  expect(event.id).toBe("evt_1");
});

it("invalid timestamp is rejected", () => {
  raises(
    () => verifyWebhook(BODY, _sign(SECRET, "not-an-int", BODY), "not-an-int", SECRET),
    WebhookVerificationError,
    /invalid timestamp header/,
  );
});

it("secret rotation accepts old or new", () => {
  const candidates = [OLD_SECRET, NEW_SECRET];
  const signedOld = verifyWebhook(BODY, _sign(OLD_SECRET, TIMESTAMP, BODY), TIMESTAMP, candidates);
  const signedNew = verifyWebhook(BODY, _sign(NEW_SECRET, TIMESTAMP, BODY), TIMESTAMP, candidates);
  expect(signedOld.id).toBe("evt_1");
  expect(signedNew.id).toBe("evt_1");
});

it("secret rotation rejects unknown secret", () => {
  raises(
    () => verifyWebhook(BODY, _sign("whsec_neither", TIMESTAMP, BODY), TIMESTAMP, [OLD_SECRET, NEW_SECRET]),
    WebhookVerificationError,
    /signature mismatch/,
  );
});

it("empty secret list is rejected", () => {
  raises(() => verifyWebhook(BODY, _sign(SECRET, TIMESTAMP, BODY), TIMESTAMP, []), WebhookVerificationError, /no secret provided/);
});

it("mac covers raw body not reserialized json", () => {
  // Whitespace-equivalent JSON is a different MAC; re-dumping the body must not verify.
  const compact = BODY;
  const pretty = Buffer.from(JSON.stringify(PAYLOAD, null, 2));
  expect(JSON.parse(compact.toString())).toEqual(JSON.parse(pretty.toString()));
  expect(compact.equals(pretty)).toBe(false);
  raises(() => verifyWebhook(pretty, _sign(SECRET, TIMESTAMP, compact), TIMESTAMP, SECRET), WebhookVerificationError, /signature mismatch/);
  const event = verifyWebhook(pretty, _sign(SECRET, TIMESTAMP, pretty), TIMESTAMP, SECRET);
  expect(event.id).toBe("evt_1");
});

it("unparsable payload after valid mac", () => {
  const raw = Buffer.from("not-json");
  raises(() => verifyWebhook(raw, _sign(SECRET, TIMESTAMP, raw), TIMESTAMP, SECRET), WebhookVerificationError, /unparsable payload/);
});

it("envelope missing fields is unparsable", () => {
  const raw = Buffer.from(JSON.stringify({ type: "session.status_updated" }));
  raises(() => verifyWebhook(raw, _sign(SECRET, TIMESTAMP, raw), TIMESTAMP, SECRET), WebhookVerificationError, /unparsable payload/);
});

it("unknown event type still verifies", () => {
  const payload = { ...PAYLOAD, type: "session.something_new" };
  const raw = Buffer.from(JSON.stringify(payload));
  const event = verifyWebhook(raw, _sign(SECRET, TIMESTAMP, raw), TIMESTAMP, SECRET);
  expect(event.type).toBe("session.something_new");
  expect(event.data).toEqual(payload.data);
});
