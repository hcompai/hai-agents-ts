/**
 * Webhook receiving: verify the signature and parse the event payload.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { HaiAgentsError } from "./errors/index.js";

export const SIGNATURE_HEADER = "X-H-Webhook-Signature";
export const TIMESTAMP_HEADER = "X-H-Webhook-Timestamp";
export const DEFAULT_TOLERANCE_S = 300;

export class WebhookVerificationError extends HaiAgentsError {
    constructor(message: string) {
        super({ message });
    }
}

/** Payload of `session.status_updated` and the granular `session.*` status events. */
export interface WebhookEventData {
    session_id: string;
    status: string;
    previous_status?: string | null;
}

/**
 * A verified webhook delivery. `data` is the raw event payload; its shape depends
 * on `type`. Branch on `type` and narrow `data` to the matching payload, e.g.
 * `data as WebhookEventData` for `session.status_updated`.
 */
export interface WebhookEvent {
    type: string;
    id: string;
    created_at: string;
    data: Record<string, unknown>;
}

export interface VerifyWebhookOptions {
    /** Maximum delivery age in seconds before the event is rejected as a replay. */
    toleranceS?: number;
}

/**
 * Authenticate a webhook delivery and return the parsed event.
 *
 * `body` must be the raw request body (never re-serialized JSON); `signature` and
 * `timestamp` come from the `X-H-Webhook-Signature` and `X-H-Webhook-Timestamp`
 * headers. `secret` may be an array of candidate secrets: pass both the old and
 * the new secret during a rotation so deliveries signed with either verify.
 * Throws {@link WebhookVerificationError} when no secret matches or the delivery
 * is older than the tolerance.
 */
export function verifyWebhook(
    body: string | Uint8Array,
    signature: string,
    timestamp: string,
    secret: string | string[],
    options: VerifyWebhookOptions = {},
): WebhookEvent {
    const toleranceS = options.toleranceS ?? DEFAULT_TOLERANCE_S;
    const raw = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
    const secrets = typeof secret === "string" ? [secret] : secret;
    if (secrets.length === 0) {
        throw new WebhookVerificationError("no secret provided");
    }
    const sentAt = Number.parseInt(timestamp, 10);
    if (Number.isNaN(sentAt)) {
        throw new WebhookVerificationError("invalid timestamp header");
    }
    if (Math.abs(Date.now() / 1000 - sentAt) > toleranceS) {
        throw new WebhookVerificationError(`delivery older than ${toleranceS}s; possible replay`);
    }
    const received = Buffer.from(signature ?? "", "utf8");
    let matched = false;
    for (const candidate of secrets) {
        const digest = createHmac("sha256", candidate)
            .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw]))
            .digest("hex");
        const expected = Buffer.from(`sha256=${digest}`, "utf8");
        if (expected.length === received.length && timingSafeEqual(expected, received)) {
            matched = true;
        }
    }
    if (!matched) {
        throw new WebhookVerificationError("signature mismatch");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString("utf8"));
    } catch (e) {
        throw new WebhookVerificationError(`unparsable payload: ${e}`);
    }
    const event = parsed as WebhookEvent;
    if (typeof event?.type !== "string" || typeof event?.id !== "string" || typeof event?.data !== "object" || event.data === null) {
        throw new WebhookVerificationError("unexpected payload shape");
    }
    return event;
}
