/**
 * test_webhook_verification.py::test_envelope_missing_fields_is_unparsable: the error text is the platform's
 * overlay's (webhookVerification.ts). Lands with the platform's client sync.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, it, vi } from "vitest";

import { WebhookVerificationError, verifyWebhook } from "hai-agents";

import { raises } from "./helpers";

const SECRET = "whsec_test";
const NOW = 1_700_000_000;
const TIMESTAMP = String(NOW);

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

it("envelope missing fields is unparsable", () => {
  const raw = Buffer.from(JSON.stringify({ type: "session.status_updated" }));
  raises(() => verifyWebhook(raw, _sign(SECRET, TIMESTAMP, raw), TIMESTAMP, SECRET), WebhookVerificationError, /unparsable payload/);
});
