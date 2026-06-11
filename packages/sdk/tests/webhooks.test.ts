import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { WebhookVerificationError, verifyWebhook } from "../src/client/webhookVerification.js";

// Webhook verification accepts genuine deliveries and rejects forgeries and replays.

const SECRET = "whsec_test";

const EVENT = {
  type: "session.status_updated",
  id: "evt_1",
  created_at: "2026-06-11T12:00:00Z",
  data: { session_id: "sess_1", status: "completed", previous_status: "running" },
};

function delivery(payload: unknown, secret = SECRET, timestamp?: number) {
  const body = JSON.stringify(payload);
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { body, signature: `sha256=${digest}`, ts };
}

describe("verifyWebhook", () => {
  it("parses a valid delivery", () => {
    const { body, signature, ts } = delivery(EVENT);
    const event = verifyWebhook(body, signature, ts, SECRET);
    expect(event.type).toBe("session.status_updated");
    expect(event.data.session_id).toBe("sess_1");
    expect(event.data.previous_status).toBe("running");
  });

  it("verifies byte bodies like string bodies", () => {
    const { body, signature, ts } = delivery(EVENT);
    const event = verifyWebhook(new TextEncoder().encode(body), signature, ts, SECRET);
    expect(event.data.status).toBe("completed");
  });

  it("rejects a tampered body", () => {
    const { body, signature, ts } = delivery(EVENT);
    const tampered = body.replace("completed", "failed");
    expect(() => verifyWebhook(tampered, signature, ts, SECRET)).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook(tampered, signature, ts, SECRET)).toThrow(/signature mismatch/);
  });

  it("rejects the wrong secret", () => {
    const { body, signature, ts } = delivery(EVENT);
    expect(() => verifyWebhook(body, signature, ts, "whsec_other")).toThrow(/signature mismatch/);
  });

  it("rejects a stale timestamp", () => {
    const { body, signature, ts } = delivery(EVENT, SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect(() => verifyWebhook(body, signature, ts, SECRET)).toThrow(/replay/);
  });

  it("rejects a signed payload with null data", () => {
    const { body, signature, ts } = delivery({ ...EVENT, data: null });
    expect(() => verifyWebhook(body, signature, ts, SECRET)).toThrow(/unexpected payload shape/);
  });

  it("rejects a garbage timestamp header", () => {
    const { body, signature } = delivery(EVENT);
    expect(() => verifyWebhook(body, signature, "not-a-number", SECRET)).toThrow(/invalid timestamp/);
  });
});
