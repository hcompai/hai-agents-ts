// The command channel, as the Python SDK's bridge speaks it: the platform (AGP or the local
// runtime) queues commands per session; the bridge long-polls them and posts each result.
// Status codes map to the same errors as the Python transport, with the platform's reason in them.

export interface Command {
  id: string;
  /** Redelivery key: the same command_uid may arrive twice and must produce one result. */
  command_uid: string;
  /** A hai-drivers interface method name, e.g. `click_at`. */
  name: string;
  /** The method's keyword arguments. */
  args: Record<string, unknown>;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface CommandResult {
  result: JsonValue;
  error: string | null;
}

export interface TransportOptions {
  /** Host without the `/api/vN` suffix: AGP, or `http://127.0.0.1:<port>` for the local runtime. */
  baseUrl: string;
  /** Python's `api_key` is a TokenSource, a string or a callable resolved per request (its manager rotates the runtime's token); a string here. */
  apiKey: string;
  /** Defaults to the global fetch; the local runtime hands over a proof-checking one. */
  fetch?: typeof fetch;
  /** Python logs through `logging` with levels (its `_is_expected` hook demotes a driver's expected errors to INFO); here the caller filters. */
  onLog?: (message: string) => void;
}

// The errors of Python's errors.py; they live here rather than in errors.ts, which is the runtime's.

/** 410: the session ended and the platform closed its command channel for good. */
export class ChannelClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelClosedError";
  }
}

/** 401 or 403: the platform rejected the API key; the bridge cannot serve. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** 404 on the poll: the command channel disappeared server-side and must be recreated. */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

/** 429: the platform asked the bridge to back off for `retryAfter` seconds; `reason` is its own words, when it gave them. */
export class RateLimitedError extends Error {
  constructor(
    readonly retryAfter: number,
    readonly reason: string | null = null,
  ) {
    super(reason ?? `rate limited; retry after ${retryAfter.toFixed(0)}s`);
    this.name = "RateLimitedError";
  }
}

/** Any other failed status (httpx's HTTPStatusError); the bridge retries 5xx and gives up on 4xx. */
export class ChannelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChannelHttpError";
  }
}

const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const DEFAULT_RETRY_AFTER_S = 5;
// httpx's default timeout, which Python's ensure_channel runs under (5 s per phase; fetch bounds the whole request).
const ENSURE_CHANNEL_TIMEOUT_MS = 5_000;
// httpx sets this on a JSON body by itself; fetch does not.
const JSON_BODY = { "Content-Type": "application/json" };

/** The poll's knobs, which the bridge sets from its constants as Python's `fetch_commands` keyword arguments. */
export interface FetchCommandsOptions {
  waitForSeconds: number;
  readTimeoutMs: number;
  maxRetries: number;
  /** The bridge's stop signal: a long poll in flight is abandoned. */
  signal?: AbortSignal;
}

export class CommandExchange {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #onLog: (message: string) => void;

  constructor(options: TransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#headers = { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#onLog = options.onLog ?? (() => {});
  }

  /** Register the channel the agent's `user_device` environment will queue commands on. */
  async ensureChannel(sessionId: string): Promise<void> {
    // No trailing slash: AGP redirects the slashed form to plain http, which fetch follows and stalls on.
    const check = await this.#fetch(`${this.#baseUrl}/api/v1/trajectories/${sessionId}`, {
      headers: this.#headers,
      signal: AbortSignal.timeout(ENSURE_CHANNEL_TIMEOUT_MS),
    });
    if (check.status === 401 || check.status === 403) {
      throw new AuthError(await said(`auth error checking channel (${check.status})`, check));
    }
    if (check.status === 429) {
      throw await rateLimited(check);
    }
    if (check.status === 200) {
      return;
    }
    const url = `${this.#baseUrl}/api/v1/trajectories/`;
    const resp = await this.#fetch(url, {
      method: "POST",
      headers: { ...this.#headers, ...JSON_BODY },
      body: JSON.stringify({ id: sessionId, task: { type: "interactive" }, launch: false }),
      signal: AbortSignal.timeout(ENSURE_CHANNEL_TIMEOUT_MS),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError(await said(`auth error creating channel (${resp.status})`, resp));
    }
    if (resp.status === 429) {
      throw await rateLimited(resp);
    }
    if (resp.status === 409) {
      return; // created concurrently
    }
    await raiseIfGone(resp, sessionId);
    await raiseForStatus(resp, "POST", url);
  }

  /** Long-poll the next batch; empty when the poll timed out with nothing to do. 502/503/504 are retried `maxRetries` times here. */
  async fetchCommands(sessionId: string, { waitForSeconds, readTimeoutMs, maxRetries, signal }: FetchCommandsOptions): Promise<Command[]> {
    const url = `${this.#baseUrl}/api/v1/commands/${sessionId}/commands?wait_for_seconds=${waitForSeconds}`;
    for (let attempt = 0; ; attempt += 1) {
      const resp = await this.#fetch(url, {
        headers: this.#headers,
        signal: AbortSignal.any([AbortSignal.timeout(readTimeoutMs), ...(signal ? [signal] : [])]),
      });
      await raiseIfGone(resp, sessionId);
      if (resp.status === 204) {
        return [];
      }
      if (resp.status === 404) {
        throw new SessionNotFoundError(await said(`channel '${sessionId}' not found`, resp));
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new AuthError(await said(`auth error (${resp.status})`, resp));
      }
      if (resp.status === 429) {
        throw await rateLimited(resp);
      }
      if (TRANSIENT_STATUS_CODES.has(resp.status) && attempt < maxRetries) {
        continue;
      }
      await raiseForStatus(resp, "GET", url);
      let body: unknown;
      try {
        body = JSON.parse(await resp.text());
      } catch {
        return []; // Python's _parse_commands: a body that is not JSON is no commands
      }
      if (!Array.isArray(body)) {
        return [];
      }
      const commands: Command[] = [];
      for (const item of body) {
        if (isCommand(item)) {
          commands.push(item);
        } else {
          this.#onLog(`skipping malformed command: ${JSON.stringify(item)}`);
        }
      }
      return commands;
    }
  }

  /** Post one result. A 404 means the platform forgot the command; its result is dropped, as in Python. */
  async postResult(command: Command, result: CommandResult, { timeoutMs }: { timeoutMs: number }): Promise<void> {
    const url = `${this.#baseUrl}/api/v1/commands/${command.id}/result`;
    const resp = await this.#fetch(url, {
      method: "POST",
      headers: { ...this.#headers, ...JSON_BODY },
      body: JSON.stringify({ ...result, command_uid: command.command_uid }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError(await said(`auth error posting result (${resp.status})`, resp));
    }
    if (resp.status === 429) {
      throw await rateLimited(resp);
    }
    if (resp.status === 409 || resp.status === 404) {
      return; // 409: another delivery of the same command already landed; 404: the platform no longer knows the command
    }
    await raiseIfGone(resp, command.id);
    await raiseForStatus(resp, "POST", url);
  }
}

/**
 * Make a driver return value JSON-safe the way the Python `serialize_result` does: bytes become
 * base64, containers are recursed, and the first value JSON cannot carry fails with its type name.
 */
export function serializeResult(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    // httpx encodes with allow_nan=False, so non-finite floats fail like unknown types: named by their type.
    throw new TypeError(typeof value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("circular reference");
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
      throw new TypeError((value as object).constructor?.name || "object");
    }
    seen.add(value); // `seen` holds the current path only, so a shared (non-circular) object is fine
    const out = Array.isArray(value)
      ? value.map((item) => serializeResult(item, seen))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeResult(item, seen)]));
    seen.delete(value);
    return out;
  }
  throw new TypeError(typeof value);
}

async function raiseIfGone(resp: Response, channel: string): Promise<void> {
  if (resp.status === 410) {
    throw new ChannelClosedError(await said(`channel for '${channel}' is closed`, resp));
  }
}

async function rateLimited(resp: Response): Promise<RateLimitedError> {
  return new RateLimitedError(retryAfter(resp), await platformMessage(resp));
}

/** httpx's `raise_for_status` with the platform's own words in the error. A fetch Response has no request, so the method and URL come in. */
async function raiseForStatus(resp: Response, method: string, url: string): Promise<void> {
  if (!resp.ok) {
    throw new ChannelHttpError(resp.status, await said(`HTTP ${resp.status} from ${method} ${new URL(url).pathname}`, resp));
  }
}

async function said(text: string, resp: Response): Promise<string> {
  const message = await platformMessage(resp);
  return message ? `${text}: ${message}` : text;
}

/** Why the platform refused, from its error body (`message`, or a FastAPI string `detail`), when it says. */
async function platformMessage(resp: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = JSON.parse(await resp.text());
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  for (const field of ["message", "detail"]) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function retryAfter(resp: Response): number {
  const seconds = Number.parseFloat(resp.headers.get("Retry-After") ?? "");
  return Number.isFinite(seconds) ? Math.max(0, seconds) : DEFAULT_RETRY_AFTER_S;
}

function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate: Record<string, unknown> = { ...value };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.command_uid === "string" &&
    typeof candidate.name === "string" &&
    (candidate.args === undefined || (typeof candidate.args === "object" && candidate.args !== null))
  );
}
