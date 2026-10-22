import { Supplier } from "../client/core/fetcher/Supplier.js";
import type { HaiAgentsClient } from "../client/oo.js";

/** Device commands by driver method name; each receives the method's keyword arguments and returns JSON. */
export type CommandHandlers = Readonly<Record<string, (args: Record<string, any>) => unknown>>;

interface Command {
  id: string;
  command_uid: string;
  name: string;
  args?: Record<string, unknown>;
}

type Outcome = readonly [result: unknown, error: string | null];

const POLL_WAIT_S = 20;
const POLL_TIMEOUT_S = 30;
const REQUEST_TIMEOUT_S = 10;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
// Gives up before callers' own startup timeouts, so the real error surfaces.
const OPEN_DEADLINE_MS = 45_000;
const OPEN_ATTEMPTS = 5;
const RESULT_ATTEMPTS = 3;
const CACHED_OUTCOMES = 512;

export class CommandBridgeError extends Error {
  override name = "CommandBridgeError";

  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * Serves one device channel: executes the commands an agent sends to a `host: "user_device"`
 * environment and posts their results, against the hosted API or a local runtime alike.
 */
export class CommandBridge {
  /** Set this as the environment's `sessionId` when creating the session. */
  readonly sessionId: string;
  readonly #client: HaiAgentsClient;
  readonly #handlers: CommandHandlers;
  readonly #stop = new AbortController();
  readonly #outcomes = new Map<string, Outcome>();
  readonly #baseUrl: string;
  #done: Promise<void> = Promise.resolve();

  private constructor(client: HaiAgentsClient, handlers: CommandHandlers, sessionId: string, baseUrl: string) {
    this.#client = client;
    this.#handlers = handlers;
    this.sessionId = sessionId;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Register the channel, then serve it in the background until it closes. */
  static async open(
    client: HaiAgentsClient,
    handlers: CommandHandlers,
    options: { sessionId?: string } = {},
  ): Promise<CommandBridge> {
    const bridge = new CommandBridge(client, handlers, options.sessionId ?? crypto.randomUUID(), await baseUrlOf(client));
    await bridge.#open();
    bridge.#done = bridge.#serve();
    bridge.#done.catch(() => {});
    return bridge;
  }

  /** Settles when the channel closes or `close()` is called; rejects if the bridge fails. */
  get done(): Promise<void> {
    return this.#done;
  }

  /** Stop serving; a command in flight finishes but its result is not posted. */
  async close(): Promise<void> {
    this.#stop.abort();
    await this.#done.catch(() => {});
  }

  get #stopped(): boolean {
    return this.#stop.signal.aborted;
  }

  async #open(): Promise<void> {
    const deadline = Date.now() + OPEN_DEADLINE_MS;
    for (let attempt = 1, backoff = 1_000; ; attempt++, backoff *= 2) {
      try {
        const existing = await this.#request(`/api/v1/trajectories/${this.sessionId}/`, { method: "GET" });
        if (existing.ok) return;
        if ([401, 403, 429].includes(existing.status)) throw await statusError(existing, "checking the device channel");
        const created = await this.#request("/api/v1/trajectories/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: this.sessionId, task: { type: "interactive" }, launch: false }),
        });
        if (created.ok || created.status === 409) return;
        throw await statusError(created, "registering the device channel");
      } catch (error) {
        const wait = retryDelay(error, backoff);
        if (wait === undefined || this.#stopped || attempt >= OPEN_ATTEMPTS || Date.now() + wait > deadline) throw error;
        await sleep(jitter(wait), this.#stop.signal);
      }
    }
  }

  async #serve(): Promise<void> {
    for (let backoff = 1_000; !this.#stopped; ) {
      const started = Date.now();
      let commands: Command[];
      try {
        const response = await this.#request(
          `/api/v1/commands/${this.sessionId}/commands?wait_for_seconds=${POLL_WAIT_S}`,
          { method: "GET" },
          POLL_TIMEOUT_S,
        );
        if (response.status === 410) return;
        if (response.status === 404) {
          await sleep(backoff, this.#stop.signal);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          await this.#open();
          continue;
        }
        if (!response.ok) throw await statusError(response, "polling device commands");
        commands = response.status === 204 ? [] : parseCommands(await response.json().catch(() => null));
        backoff = 1_000;
      } catch (error) {
        if (this.#stopped) return;
        const wait = retryDelay(error, backoff);
        if (wait === undefined) throw error;
        await sleep(jitter(wait), this.#stop.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      for (const command of commands) {
        if (!(await this.#handle(command))) return;
      }
      if (commands.length === 0 && Date.now() - started < MIN_POLL_INTERVAL_MS) {
        await sleep(MIN_POLL_INTERVAL_MS, this.#stop.signal);
      }
    }
  }

  /** Run once per `command_uid`, reposting the cached outcome on redelivery; false once serving must end. */
  async #handle(command: Command): Promise<boolean> {
    let outcome = this.#outcomes.get(command.command_uid);
    if (outcome) {
      this.#outcomes.delete(command.command_uid);
    } else {
      outcome = await this.#execute(command);
      if (this.#stopped) return false;
    }
    this.#outcomes.set(command.command_uid, outcome);
    if (this.#outcomes.size > CACHED_OUTCOMES) this.#outcomes.delete(this.#outcomes.keys().next().value!);
    return this.#post(command, outcome);
  }

  async #execute({ name, args }: Command): Promise<Outcome> {
    const handler = Object.hasOwn(this.#handlers, name) ? this.#handlers[name] : undefined;
    if (typeof handler !== "function") return [null, `command '${name}' is not supported by this bridge`];
    try {
      const result = await handler(args ?? {});
      return [JSON.parse(JSON.stringify(result ?? null)), null];
    } catch (error) {
      return [null, (error instanceof Error ? error.message : String(error)) || `command '${name}' failed`];
    }
  }

  async #post(command: Command, [result, error]: Outcome): Promise<boolean> {
    const body = JSON.stringify({ result, error, command_uid: command.command_uid });
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.#request(`/api/v1/commands/${command.id}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (response.status === 410) return false;
        if (response.ok || response.status === 409) return true;
        throw await statusError(response, `posting the result of '${command.name}'`);
      } catch (failure) {
        if (this.#stopped) return false;
        if (attempt >= RESULT_ATTEMPTS) throw failure;
        await sleep(500 * attempt, this.#stop.signal);
      }
    }
  }

  #request(path: string, init: RequestInit, timeoutInSeconds = REQUEST_TIMEOUT_S): Promise<Response> {
    return this.#client.fetch(`${this.#baseUrl}${path}`, init, {
      timeoutInSeconds,
      maxRetries: 0,
      abortSignal: this.#stop.signal,
    });
  }
}

// The client's passthrough fetch percent-encodes the query of a relative path, so requests go out absolute.
async function baseUrlOf(client: HaiAgentsClient): Promise<string> {
  const { baseUrl, environment } = (client as unknown as { _options: { baseUrl?: Supplier<string>; environment?: Supplier<string> } })._options;
  const resolved = await Supplier.get((baseUrl ?? environment)!);
  if (!resolved) throw new CommandBridgeError("the client has no base URL");
  return resolved;
}

async function statusError(response: Response, action: string): Promise<CommandBridgeError> {
  const detail = (await response.text().catch(() => "")).slice(0, 500);
  const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
  return new CommandBridgeError(
    `${action} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
    response.status,
    Number.isFinite(seconds) ? Math.max(seconds, 0) * 1_000 : undefined,
  );
}

/** Delay before retrying a transient failure (network, timeout, 429, 5xx); undefined when it is fatal. */
function retryDelay(error: unknown, backoff: number): number | undefined {
  if (error instanceof CommandBridgeError) {
    if (error.status === 429) return Math.max(error.retryAfterMs ?? 5_000, 1_000);
    return error.status !== undefined && error.status >= 500 ? backoff : undefined;
  }
  return error instanceof TypeError || (error as Error | undefined)?.name === "TimeoutError" ? backoff : undefined;
}

function parseCommands(body: unknown): Command[] {
  if (!Array.isArray(body)) return [];
  return body.filter(
    (item): item is Command =>
      typeof item?.id === "string" && typeof item.command_uid === "string" && typeof item.name === "string",
  );
}

function jitter(ms: number): number {
  return ms * (1 + Math.random() * 0.25);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
