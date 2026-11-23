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
        super(buildMessage({ message, statusCode, body, rawResponse }));
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

/**
 * Python's `ApiError.__str__`: the server's detail with the status, else the headers, status and
 * body. A client-side error (no status, no body) keeps its own message.
 */
function buildMessage({
    message,
    statusCode,
    body,
    rawResponse,
}: {
    message: string | undefined;
    statusCode: number | undefined;
    body: unknown | undefined;
    rawResponse: core.RawResponse | undefined;
}): string {
    const detail = serverDetail(body);
    if (detail != null) {
        return `${detail} (status_code: ${statusCode ?? "null"})`;
    }
    if (statusCode == null && body == null) {
        return message ?? "";
    }
    const headers = rawResponse != null ? toJson(Object.fromEntries(rawResponse.headers)) : "null";
    const bodyText = body == null ? "null" : typeof body === "string" ? body : toJson(body);
    return `headers: ${headers}, status_code: ${statusCode ?? "null"}, body: ${bodyText}`;
}
