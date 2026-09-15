import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { WebhookVerificationError, verifyWebhook } from "../src/index.js";

const secret = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "session.status_updated", data: { session_id: "s1", status: "idle" } });
const timestamp = String(Math.floor(Date.now() / 1000));
const sign = (key: string) => `sha256=${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`;

describe("verifyWebhook", () => {
  it("accepts a delivery signed with any of the candidate secrets", () => {
    const event = verifyWebhook(body, sign(secret), timestamp, ["retired", secret]);
    expect(event.id).toBe("evt_1");
    expect(event.data.status).toBe("idle");
  });

  it("accepts the raw body as bytes", () => {
    expect(verifyWebhook(new TextEncoder().encode(body), sign(secret), timestamp, secret).id).toBe("evt_1");
  });

  it("rejects a signature made with another secret", () => {
    expect(() => verifyWebhook(body, sign("other"), timestamp, secret)).toThrow(WebhookVerificationError);
  });

  it("rejects a stale delivery", () => {
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(() => verifyWebhook(body, sign(secret), old, secret)).toThrow(/replay/);
  });
});
