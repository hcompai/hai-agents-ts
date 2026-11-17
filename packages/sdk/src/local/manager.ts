// The process-wide bridge manager, as hai_agents_local/manager.py: at most one bridge per
// environment kind, the newest session taking a kind over from the previous one. Python runs each
// bridge on a daemon thread, so the process can exit under it and atexit stops what is left; here
// each bridge is its `start()` promise on the one event loop, which keeps the process alive while a
// bridge serves (the loop ends when the session's channel closes, or on stop()), so there is no exit
// hook. Web only: no preflight (the macOS input permission prompt is desktop-only) and no desktop claim.
// Python logs through `logging`; warnings and errors go to the console here, the info lines are dropped.
// TS ahead of Python (`ts-ahead` in parity-exceptions.json): a bridge that is not `exclusive` (a web
// bridge on a caller's Playwright context) is keyed by its session id alone and never displaces or is
// displaced, so N sessions serve at once from one process; the bridges on the machine's one Chrome
// keep Python's one-per-kind rule.

export const STOP_JOIN_TIMEOUT_S = 5.0;
export const READY_TIMEOUT_S = 60.0;

/** Python's builtin TimeoutError, raised when a bridge does not confirm its stop; Node has none. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** What the manager drives. Python's LocalBridge base class carries these; here PlaywrightBrowserBridge does, the TS LocalBridge being the loop it composes. */
export interface ManagedBridge {
  readonly environmentKind: string;
  readonly environmentId: string;
  readonly sessionId: string;
  /** Appended to the not-ready timeout error; names the common cause of a hung startup. */
  readonly startupHint?: string;
  /** True once the bridge serves; stays true after the loop ends, cleared by the next `start()`. */
  readonly ready: boolean;
  /** False for a bridge on a browser of its own, served beside others; true or absent is Python's one-per-kind rule (ts-ahead, header). */
  readonly exclusive?: boolean;
  /** Fired once by the manager when the loop dies after startup; async here, as cancelling a session is an HTTP call. */
  onCrash: (() => void | Promise<void>) | null;
  /** Resolves once the bridge is ready; rejects when it cannot start. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Rejects when the loop crashes; resolves when it stops. */
  readonly done: Promise<void>;
}

export class BridgeManager {
  /** Runs each bridge on a daemon thread, at most one per environment kind. */
  private readonly _runners = new Map<string, _Runner>();

  /** Start any bridges not already running; returns the session ids of newly started ones. */
  async ensure(bridges: readonly ManagedBridge[]): Promise<string[]> {
    const kinds = bridges.filter(exclusive).map((bridge) => bridge.environmentKind); // ts-ahead: one batch may hold several bridges on their own browsers
    for (const kind of kinds) {
      if (kinds.filter((other) => other === kind).length > 1) {
        throw new Error(`cannot serve two local ${kind} environments from one machine`);
      }
    }
    const started: string[] = [];
    try {
      for (const bridge of bridges) {
        if (await this._ensureOne(bridge)) {
          started.push(bridge.sessionId);
        }
      }
    } catch (error) {
      try {
        await this.stop(started);
      } catch (cleanup) {
        console.error("Failed to clean up bridges after startup failure", cleanup);
      }
      throw error;
    }
    return started;
  }

  private async _ensureOne(bridge: ManagedBridge): Promise<boolean> {
    // Python runs bridge.preflight() here, the macOS input permission prompt: desktop only, nothing to check for a browser.
    let displaced: _Runner[] = [];
    let runner = this._runners.get(bridge.sessionId);
    const started = runner === undefined || !runner.alive;
    if (started) {
      displaced = this._displaceKind(bridge);
      runner = new _Runner(bridge);
      this._runners.set(bridge.sessionId, runner);
    }
    for (const other of displaced) {
      try {
        await other.stop();
      } catch (error) {
        if (!(error instanceof TimeoutError)) {
          throw error;
        }
        console.error("Displaced bridge did not stop in time", error);
      } finally {
        await other.notifyLost();
      }
    }
    try {
      if (!(await runner!.readyWithin(READY_TIMEOUT_S))) {
        const hint = bridge.startupHint !== undefined ? ` (${bridge.startupHint})` : "";
        throw new Error(
          `local ${bridge.environmentKind} bridge for environment '${bridge.environmentId}' ` +
            `was not ready after ${READY_TIMEOUT_S.toFixed(0)}s${hint}`,
        );
      }
      if (runner!.error !== undefined) {
        throw new Error(
          `local ${bridge.environmentKind} bridge for environment '${bridge.environmentId}' ` +
            `failed to start: ${describe(runner!.error)}`,
          { cause: runner!.error },
        );
      }
    } catch (error) {
      if (started) {
        if (this._runners.get(bridge.sessionId) === runner) {
          this._runners.delete(bridge.sessionId);
        }
        try {
          await runner!.stop();
        } catch (cleanup) {
          console.error("Failed to clean up bridge after startup failure", cleanup);
        }
      }
      throw error;
    }
    return started;
  }

  /**
   * One driver per kind: a machine has one debuggable Chrome, so the newest session takes the
   * bridge over from any previous session still holding it. Returns the displaced runners; the
   * caller stops them and fires their loss handlers.
   */
  private _displaceKind(bridge: ManagedBridge): _Runner[] {
    const displaced: _Runner[] = [];
    if (!exclusive(bridge)) {
      return displaced; // ts-ahead: a browser of its own takes nothing over
    }
    for (const [sid, other] of [...this._runners]) {
      if (other.bridge.environmentKind !== bridge.environmentKind || !exclusive(other.bridge)) {
        continue;
      }
      if (other.alive) {
        console.warn(
          `stopping the local ${bridge.environmentKind} bridge for session ${other.bridge.sessionId} to serve session ${bridge.sessionId}`,
        );
      }
      this._runners.delete(sid);
      displaced.push(other);
    }
    return displaced;
  }

  async stop(sessionIds: readonly string[]): Promise<void> {
    const stopping = sessionIds.flatMap((sid) => this._runners.get(sid) ?? []);
    const failures: string[] = [];
    for (const runner of stopping) {
      try {
        await runner.stop();
      } catch (error) {
        if (!(error instanceof TimeoutError)) {
          throw error;
        }
        failures.push(error.message);
        continue;
      }
      if (this._runners.get(runner.bridge.sessionId) === runner) {
        this._runners.delete(runner.bridge.sessionId);
      }
    }
    if (failures.length > 0) {
      throw new TimeoutError(failures.join("; "));
    }
  }

  async stopAll(): Promise<void> {
    await this.stop([...this._runners.keys()]);
  }

  /** The given bridges that are still running. */
  serving(sessionIds: readonly string[]): string[] {
    return sessionIds.filter((sid) => this._runners.get(sid)?.alive === true);
  }
}

export class _Runner {
  readonly bridge: ManagedBridge;
  error: unknown = undefined;
  /** Python's `thread.is_alive()`: true until the bridge's loop has ended. */
  alive = true;
  readonly #served: Promise<void>;
  readonly #ready: Promise<void>;
  #setReady!: () => void;
  #inLossHandler = false;

  constructor(bridge: ManagedBridge) {
    this.bridge = bridge;
    // Python clears the bridge's ready event here; the TS LocalBridge clears it in start().
    this.#ready = new Promise<void>((resolve) => {
      this.#setReady = resolve;
    });
    this.#served = this._serve();
  }

  private async _serve(): Promise<void> {
    try {
      await this.bridge.start();
      if (!this.bridge.ready) {
        // Stopped mid-setup (e.g. displaced during channel retry backoff): the finally
        // below unblocks ensure(), which must see a failure, not a serving bridge.
        this.error = new Error("bridge was stopped before it became ready");
        return;
      }
      this.#setReady();
      await this.bridge.done;
    } catch (exc) {
      this.error = exc;
      // Startup failures surface to the ensure() caller; only a crash after startup is logged here.
      if (this.bridge.ready) {
        console.error(`local ${this.bridge.environmentKind} bridge crashed`, exc);
        await this.notifyLost();
      }
    } finally {
      this.alive = false;
      this.#setReady();
    }
  }

  /** Python's `bridge.ready.wait(timeout)`: true once ready (or the loop ended), false on timeout. */
  async readyWithin(seconds: number): Promise<boolean> {
    return settledWithin(this.#ready, seconds);
  }

  /**
   * Fires the bridge's loss handler once, on crash or displacement after a successful startup;
   * startup failures surface to the ensure() caller instead.
   */
  async notifyLost(): Promise<void> {
    const handler = this.bridge.onCrash;
    this.bridge.onCrash = null;
    if (handler !== null && this.bridge.ready) {
      this.#inLossHandler = true;
      try {
        await handler();
      } catch (error) {
        console.error("bridge loss handler failed", error);
      } finally {
        this.#inLossHandler = false;
      }
    }
  }

  async stop(): Promise<void> {
    // Python's request_stop never raises; the TS stop() rejects with the loop's own failure, which `error` already holds.
    const stopped = this.bridge.stop().catch(() => undefined);
    // A bridge's loss handler runs inside its own runner's loop; the runner cannot wait for itself.
    if (this.#inLossHandler) {
      await stopped;
      return;
    }
    if (!(await settledWithin(Promise.all([stopped, this.#served]), STOP_JOIN_TIMEOUT_S))) {
      throw new TimeoutError(`Could not confirm stop of local ${this.bridge.environmentKind} bridge`);
    }
  }
}

/** True when `promise` settles within `seconds`; Python's `thread.join(timeout)` / `Event.wait(timeout)`. */
function settledWithin(promise: Promise<unknown>, seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), seconds * 1000);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python's rule unless the bridge opts out (ts-ahead, header). */
function exclusive(bridge: ManagedBridge): boolean {
  return bridge.exclusive !== false;
}

// Process-wide manager behind ensureBridges / stopBridges.
export const _defaultManager = new BridgeManager();

export function ensureBridges(bridges: readonly ManagedBridge[]): Promise<string[]> {
  return _defaultManager.ensure(bridges);
}

export function servingBridges(sessionIds: readonly string[]): string[] {
  return _defaultManager.serving(sessionIds);
}

export function stopBridges(sessionIds?: readonly string[]): Promise<void> {
  return sessionIds === undefined ? _defaultManager.stopAll() : _defaultManager.stop(sessionIds);
}
