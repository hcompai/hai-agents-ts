// The command loop, as the Python SDK's LocalBridge: serves one `user_device` environment for
// the length of a session. Registers a channel, long-polls it, hands each command to the driver
// and posts the result. The agent's environment carries this bridge's `sessionId`.

import { randomUUID } from "node:crypto";
import {
  AuthError,
  ChannelClosedError,
  ChannelHttpError,
  CommandExchange,
  RateLimitedError,
  SessionNotFoundError,
  serializeResult,
} from "./transport.js";
import type { Command, CommandResult, TransportOptions } from "./transport.js";

export interface CommandDriver {
  /** Run one command; a thrown error becomes the command's error string. */
  dispatch(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface LocalBridgeOptions extends TransportOptions {
  /** The driver, or Python's `create_driver`: a factory `start()` runs once the channel is open. */
  driver: CommandDriver | (() => CommandDriver | Promise<CommandDriver>);
  /** The channel id; a fresh UUID when absent. The routing layer seeds it so an idempotent retry reuses it. */
  sessionId?: string;
  /** Called with each command before it runs. */
  onCommand?: (name: string, args: Record<string, unknown>) => void;
}

const LONG_POLL_SECONDS = 20;
const LONG_POLL_READ_TIMEOUT_MS = 21_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const POST_RESULT_TIMEOUT_MS = 10_000;
const POST_RESULT_RETRIES = 2;
const FETCH_TRANSIENT_RETRIES = 2;
const CHANNEL_SETUP_ATTEMPTS = 5;
// Must stay under the manager's READY_TIMEOUT_S so setup gives up with the real
// error instead of the manager's generic not-ready timeout firing first.
const CHANNEL_SETUP_TIMEOUT_MS = 45_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 1_000;
const RESULT_CACHE_SIZE = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LocalBridge {
  /** The channel id, to stamp into the environment as `sessionId`. */
  readonly sessionId: string;
  /** True once the channel is registered (Python's `ready` Event), cleared by each `start()`; the manager reads it. */
  ready = false;
  readonly #exchange: CommandExchange;
  readonly #createDriver: () => CommandDriver | Promise<CommandDriver>;
  #driver: CommandDriver | null = null;
  readonly #onCommand: LocalBridgeOptions["onCommand"];
  readonly #onLog: (message: string) => void;
  // Python's run() takes a fresh stop event per run; a restarted bridge needs a fresh controller too.
  #stop = new AbortController();
  /** Results by command_uid, so a redelivered command reposts instead of running twice. */
  readonly #results = new Map<string, CommandResult>();
  #serving: Promise<void> | null = null;

  constructor(options: LocalBridgeOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }
    if (options.sessionId !== undefined && !UUID.test(options.sessionId)) {
      throw new Error(`sessionId must be a UUID (the platform rejects '${options.sessionId}')`);
    }
    this.sessionId = options.sessionId ?? randomUUID();
    this.#exchange = new CommandExchange(options);
    const driver = options.driver;
    this.#createDriver = typeof driver === "function" ? driver : () => driver;
    this.#onCommand = options.onCommand;
    this.#onLog = options.onLog ?? (() => {});
  }

  /**
   * Register the channel, build the driver, then serve the channel in the background until
   * `stop()` or the session ends (Python's `run`: `_open_channel`, `create_driver`, `_poll_loop`).
   */
  async start(): Promise<void> {
    this.ready = false;
    this.#stop = new AbortController();
    if (!(await this.#openChannel())) {
      return;
    }
    this.#driver = await this.#createDriver();
    this.ready = true;
    this.#serving = this.#serve();
  }

  /**
   * Open the command channel, retrying rate limits and transient failures with jittered backoff,
   * up to CHANNEL_SETUP_ATTEMPTS or the setup deadline, whichever comes first. False means a stop
   * was requested mid-setup; definitive failures (auth, 4xx, anything but HTTP) throw.
   */
  async #openChannel(): Promise<boolean> {
    const deadline = Date.now() + CHANNEL_SETUP_TIMEOUT_MS;
    let delayMs = 1_000;
    for (let attempt = 1; attempt <= CHANNEL_SETUP_ATTEMPTS; attempt += 1) {
      try {
        await this.#exchange.ensureChannel(this.sessionId);
        return true;
      } catch (error) {
        const jitter = 1 + Math.random() * 0.25;
        let backoffMs: number;
        if (error instanceof RateLimitedError) {
          backoffMs = Math.max(error.retryAfter * 1000, MIN_RATE_LIMIT_BACKOFF_MS) * jitter;
          if (attempt === CHANNEL_SETUP_ATTEMPTS || Date.now() + backoffMs > deadline) {
            throw new Error(
              error.reason
                ? `the platform refused command-channel setup: ${error.reason}`
                : "the platform kept rate-limiting command-channel setup; wait a minute and retry",
              { cause: error },
            );
          }
          this.#onLog(`platform refused channel setup (attempt ${attempt}/${CHANNEL_SETUP_ATTEMPTS}): ${describe(error)}; retrying in ${(backoffMs / 1000).toFixed(1)}s`);
        } else {
          backoffMs = delayMs * jitter;
          const definitive = !isHttpError(error) || (error instanceof ChannelHttpError && error.status < 500);
          if (definitive || attempt === CHANNEL_SETUP_ATTEMPTS || Date.now() + backoffMs > deadline) {
            throw error;
          }
          this.#onLog(`channel setup failed (attempt ${attempt}/${CHANNEL_SETUP_ATTEMPTS}): ${describe(error)}; retrying in ${(backoffMs / 1000).toFixed(1)}s`);
          delayMs = Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS);
        }
        await this.#sleep(backoffMs);
        if (this.#stop.signal.aborted) {
          return false;
        }
      }
    }
    return false;
  }

  /** Stop polling; resolves once the loop has exited. Idempotent. */
  // No driver teardown: Python's _serve finally calls driver.destroy() / close(); the hai node driver's destroy is a no-op, and PlaywrightBrowserBridge releases what it launched.
  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#serving;
    this.#serving = null;
  }

  /** Rejects if the loop died (rejected key, permanent 4xx); resolves when it stops. */
  get done(): Promise<void> {
    return this.#serving ?? Promise.resolve();
  }

  async #serve(): Promise<void> {
    let retryDelayMs = 1_000;
    let recreateChannel = false;
    while (!this.#stop.signal.aborted) {
      const startedAt = Date.now();
      try {
        if (recreateChannel) {
          await this.#exchange.ensureChannel(this.sessionId);
          recreateChannel = false;
        }
        const commands = await this.#exchange.fetchCommands(this.sessionId, {
          waitForSeconds: LONG_POLL_SECONDS,
          readTimeoutMs: LONG_POLL_READ_TIMEOUT_MS,
          maxRetries: FETCH_TRANSIENT_RETRIES,
          signal: this.#stop.signal,
        });
        retryDelayMs = 1_000;
        if (commands.length > 0) {
          await this.#process(commands);
        } else if (Date.now() - startedAt < MIN_POLL_INTERVAL_MS) {
          // An instant empty poll is paced, so a misbehaving server cannot cause a busy loop.
          await this.#sleep(MIN_POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (this.#stop.signal.aborted) {
          return;
        }
        if (error instanceof ChannelClosedError) {
          this.#onLog(`channel ${this.sessionId} closed; the session ended`);
          return;
        }
        if (error instanceof AuthError) {
          throw error; // waiting will not heal a rejected key
        }
        if (error instanceof SessionNotFoundError) {
          // The platform garbage-collected the channel; re-register on the next turn.
          this.#onLog(`channel ${this.sessionId} missing; recreating`);
          recreateChannel = true;
          await this.#sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, MAX_RECONNECT_DELAY_MS);
          continue;
        }
        if (error instanceof RateLimitedError) {
          const backoffMs = Math.max(error.retryAfter * 1000, MIN_RATE_LIMIT_BACKOFF_MS);
          this.#onLog(`rate limited: ${describe(error)}; backing off ${(backoffMs / 1000).toFixed(0)}s`);
          await this.#sleep(backoffMs);
          continue;
        }
        if (!isHttpError(error) || (error instanceof ChannelHttpError && error.status < 500)) {
          throw error; // a 4xx will not heal by waiting; anything but HTTP is the bridge's own failure
        }
        // Network blips and 5xx: back off, then keep serving when the platform returns.
        this.#onLog(`connection error: ${describe(error)}; retrying in ${retryDelayMs / 1000}s`);
        await this.#sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  /**
   * Commands run one at a time, with no deadline of their own: the driver bounds navigation and
   * scripts itself.
   */
  async #process(commands: Command[]): Promise<void> {
    for (const command of commands) {
      if (this.#stop.signal.aborted) {
        return;
      }
      let outcome = this.#results.get(command.command_uid);
      if (outcome === undefined) {
        this.#onCommand?.(command.name, command.args ?? {});
        outcome = await this.#run(command);
        if (this.#stop.signal.aborted) {
          // Python also calls interrupt_driver() first; the TS driver has no interrupt hook, so the command runs out.
          return;
        }
        this.#results.set(command.command_uid, outcome);
        if (this.#results.size > RESULT_CACHE_SIZE) {
          const oldest = this.#results.keys().next().value;
          if (oldest !== undefined) {
            this.#results.delete(oldest);
          }
        }
      }
      await this.#deliver(command, outcome);
    }
  }

  async #run(command: Command): Promise<CommandResult> {
    let raw: unknown;
    try {
      if (this.#driver === null) {
        throw new Error("the bridge is not started");
      }
      raw = await this.#driver.dispatch(command.name, command.args ?? {});
    } catch (error) {
      const message = describe(error);
      this.#onLog(`command ${command.name} failed: ${message}`);
      return { result: null, error: message };
    }
    try {
      return { result: serializeResult(raw), error: null };
    } catch (error) {
      this.#onLog(`command ${command.name} returned a result JSON can't encode: ${describe(error)}`);
      return { result: null, error: `result of '${command.name}' is not JSON-serializable: ${describe(error)}` };
    }
  }

  /**
   * Post the result, retrying rate limits and transient failures POST_RESULT_RETRIES times. Then the
   * error reaches the poll loop, which backs off; the redelivered command reposts from the cache.
   */
  async #deliver(command: Command, outcome: CommandResult): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#exchange.postResult(command, outcome, { timeoutMs: POST_RESULT_TIMEOUT_MS });
        return;
      } catch (error) {
        if (error instanceof AuthError || error instanceof ChannelClosedError || attempt === POST_RESULT_RETRIES) {
          throw error;
        }
        let delayMs: number;
        if (error instanceof RateLimitedError) {
          delayMs = Math.max(error.retryAfter * 1000, MIN_RATE_LIMIT_BACKOFF_MS);
          this.#onLog(`post result for ${command.id} rate limited: ${describe(error)}; retrying in ${(delayMs / 1000).toFixed(0)}s`);
        } else {
          delayMs = 500 * (attempt + 1);
          this.#onLog(`post result for ${command.id} failed (attempt ${attempt + 1}): ${describe(error)}`);
        }
        await this.#sleep(delayMs);
        if (this.#stop.signal.aborted) {
          return;
        }
      }
    }
  }

  /** Sleep up to `ms`, or until a stop is requested (Python's `_interruptible_sleep`; the caller reads the signal). */
  #sleep(ms: number): Promise<void> {
    if (this.#stop.signal.aborted) {
      return Promise.resolve(); // an abort listener never fires on a signal already aborted, where a set asyncio.Event returns at once
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#stop.signal.removeEventListener("abort", wake);
        resolve();
      }, ms);
      this.#stop.signal.addEventListener("abort", wake, { once: true });
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python retries `httpx.HTTPError`: a failed status (ChannelHttpError) or fetch's own failures, a TypeError or an abort / timeout. */
function isHttpError(error: unknown): boolean {
  return error instanceof ChannelHttpError || error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}
