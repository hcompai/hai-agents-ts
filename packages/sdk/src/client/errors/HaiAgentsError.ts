import type * as core from "../core/index.js";
import { toJson } from "../core/json.js";

export class HaiAgentsError extends Error {
    public readonly statusCode?: number;
    public readonly body?: unknown;
    public readonly rawResponse?: core.RawResponse;
    public readonly cause?: unknown;

    constructor({
        message,
        statusCode,
        body,
        rawResponse,
        cause,
    }: {
        message?: string;
        statusCode?: number;
        body?: unknown;
        rawResponse?: core.RawResponse;
        cause?: unknown;
    }) {
        super(buildMessage({ message, statusCode, body }));
        Object.setPrototypeOf(this, new.target.prototype);
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }

        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.body = body;
        this.rawResponse = rawResponse;
        if (cause != null) {
            this.cause = cause;
        }
    }
}

/**
 * The human-readable reason the server sent, when it sent one. The API answers errors
 * with `{ message, detail }` where `detail` is a string, a `{ message }` object, or a list
 * of `{ msg }` / `{ message }` items (FastAPI validation errors).
 */
function serverDetail(body: unknown): string | undefined {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const { detail, message } = body as { detail?: unknown; message?: unknown };
    if (Array.isArray(detail)) {
        const parts = detail.map(text).filter((part): part is string => part !== undefined);
        return parts.length > 0 ? parts.join("; ") : text(message);
    }
    return text(detail) ?? text(message);
}

function text(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "object" && value !== null) {
        const { msg, message } = value as { msg?: unknown; message?: unknown };
        if (typeof msg === "string") {
            return msg;
        }
        if (typeof message === "string") {
            return message;
        }
    }
    return undefined;
}

function buildMessage({
    message,
    statusCode,
    body,
}: {
    message: string | undefined;
    statusCode: number | undefined;
    body: unknown | undefined;
}): string {
    const lines: string[] = [];
    const detail = serverDetail(body);
    if (message != null) {
        lines.push(message);
    }
    if (detail != null && detail !== message) {
        lines.push(detail);
    }

    if (statusCode != null) {
        lines.push(`Status code: ${statusCode.toString()}`);
    }

    if (body != null && detail == null) {
        lines.push(`Body: ${toJson(body, undefined, 2)}`);
    }

    return lines.join("\n");
}
