// The sessions client that auto-starts local bridges for user_device environments, as
// hai_agents_local/sessions.py. Python has a sync and an async client sharing _LocalSessionsState;
// TS has the one async client, so the state lives on it. Cut, with a note where each sat: the kill
// switch (_ensure_stop_watcher, _panic_stop, the stop watcher _guard checks: a terminal double-Esc,
// no terminal UI here), the desktop preflight, own_session_ids (the runtime's idle check, which
// runtime.ts leaves out) and local_environment_kinds (the CLI's preview of the kinds a run needs).
// Python logs through the module's `logging` logger; this module's logger prints warnings and errors
// to the console, as Python's default handler does, whatever the client's `logging` option says.
// TS ahead of Python (`ts-ahead` in parity-exceptions.json): `autoBridges` is
// `true | false | { web?: (environment) => WebBridgeOptions }`, the object form handed to the walk as
// `bridgeOptions` (routing.ts); Python's `auto_bridges` is a bool.

import { createHmac } from "node:crypto";

import { type HaiAgents, HaiAgentsClient as BaseClient, HaiAgentsEnvironment, HaiAgentsError, isTerminalSessionStatus, logging } from "../client/index.js";
import type { PlaywrightBrowserBridge } from "./browser.js";
import { autoBridgesEnabled } from "./config.js";
import { AgentsClient, type ClientOptions, EnvironmentsClient, HttpResponsePromise, type RequestOptions, type Sessions, SessionsClient, type WithRaw } from "./generated.js";
import { TimeoutError, ensureBridges, servingBridges, stopBridges } from "./manager.js";
import { type AutoBridgeOptions, type AutoBridges, type Reference, type Resolved, localizeAgent, references, splitRevision } from "./routing.js";
import type { LocalRuntime } from "./runtime.js";

type Session = HaiAgents.Session;
type SessionRequest = HaiAgents.SessionRequest;
type SessionRequestAgent = HaiAgents.SessionRequestAgent;
type SessionStatus = HaiAgents.SessionStatus;
type CreateSessionRequest = HaiAgents.CreateSessionRequest;
type CancelSessionRequest = HaiAgents.CancelSessionRequest;
type GetSessionStatusRequest = HaiAgents.GetSessionStatusRequest;
type SendSessionMessagesRequest = HaiAgents.SendSessionMessagesRequest;

const logger = logging.createLogger({ level: logging.LogLevel.Warn });

// Runaway guards for sessions whose caller passes no budget: a local session left running (its
// serving process was SIGKILLed, the laptop slept) burns steps against a dead channel until it
// hits these. Explicit values, including null for unbounded, are respected.
export const DEFAULT_LOCAL_MAX_STEPS = 150;
export const DEFAULT_LOCAL_MAX_TIME_S = 1800.0;
export const REMOTE_CANCEL_TIMEOUT_S = 60.0;

function _applyRunawayBudgets(body: SessionRequest): void {
  // Python's setdefault: an explicit null (Python's None, unbounded) stays.
  if (body.maxSteps === undefined) {
    body.maxSteps = DEFAULT_LOCAL_MAX_STEPS;
  }
  if (body.maxTimeS === undefined) {
    body.maxTimeS = DEFAULT_LOCAL_MAX_TIME_S;
  }
}

/** Stop bridges inside a catch block; a stop failure is logged so the handled error still propagates. */
async function _stopBridgesKeepingError(sessionIds: readonly string[]): Promise<void> {
  try {
    await stopBridges(sessionIds);
  } catch (error) {
    logger.warn("could not confirm local bridges stopped after a failed session create", error);
  }
}

/** Python's _token_source + _resolve_token: the key the client's requests carry, as BearerAuthProvider reads it. */
async function _resolveToken(options: ClientOptions): Promise<string> {
  const token = (await supplied(options.apiKey)) ?? process.env.HAI_API_KEY;
  if (token == null) {
    // BearerAuthProvider's own text; the class is not exported by the main entry.
    throw new HaiAgentsError({ message: "Please provide 'apiKey' when initializing the client, or set the 'HAI_API_KEY' environment variable" });
  }
  return token;
}

/** Python's client_wrapper.get_base_url(): the chain the generated resources resolve. */
async function _baseUrl(options: ClientOptions): Promise<string> {
  return (await supplied(options.baseUrl)) ?? (await supplied(options.environment)) ?? HaiAgentsEnvironment.Eu;
}

/** `core.Supplier.get`: a client option is a value, a promise or a function returning either. */
async function supplied<T>(supplier: T | Promise<T> | (() => T | Promise<T>) | undefined): Promise<T | undefined> {
  return typeof supplier === "function" ? (supplier as () => T | Promise<T>)() : supplier;
}

/** Idempotency keys are scoped per caller on the platform, so bridge ids seeded from them must be too. */
function _caller(apiKey: string, baseUrl: string): string {
  return createHmac("sha256", apiKey).update(baseUrl).digest("hex");
}

function _warnIfOverridesTargetUserDevice(body: SessionRequest): void {
  const overrides = body.overrides;
  if (overrides && JSON.stringify(overrides).includes("user_device")) {
    logger.warn(
      "session overrides mention user_device, but auto-started bridges are derived from the agent " +
        "spec only; serve override-injected environments manually with `new PlaywrightBrowserBridge({ sessionId })`",
    );
  }
}

function _wantsBridges(autoBridges: AutoBridges, body: SessionRequest): boolean {
  return autoBridges !== false && body.agent != null && autoBridgesEnabled();
}

/** The product's bridge options when `autoBridges` carries some (ts-ahead, routing.ts). */
function _bridgeOptions(autoBridges: AutoBridges): AutoBridgeOptions | undefined {
  return typeof autoBridges === "object" ? autoBridges : undefined;
}

/**
 * Fetch the specs behind the names in `agent`; a name that cannot be fetched gets no bridge.
 * Python's sync client fetches them one by one and its async one gathers them; this is the async one.
 */
async function _resolveReferences(options: ClientOptions, agent: SessionRequestAgent): Promise<Resolved> {
  const agents = new AgentsClient(options);
  const environments = new EnvironmentsClient(options);

  async function fetch(reference: Reference): Promise<unknown> {
    const at = reference.indexOf(":");
    const kind = reference.slice(0, at);
    const name = reference.slice(at + 1);
    try {
      if (kind === "agent") {
        const [agentName, revision] = splitRevision(name);
        return await agents.getAgent({ agentName, revision, resolve: true });
      }
      return await environments.getEnvironment({ id: name });
    } catch (error) {
      // Python catches ApiError, ParsingError and httpx.HTTPError; the generated TS client raises HaiAgentsError for all three.
      if (!(error instanceof HaiAgentsError)) {
        throw error;
      }
      logger.debug(`cannot fetch ${kind} '${name}' to look for user_device environments: ${error.message}`);
      return undefined;
    }
  }

  const found = references(agent);
  const specs = await Promise.all(found.map(fetch));
  const resolved: Resolved = {};
  found.forEach((reference, index) => {
    if (specs[index] !== undefined) {
      resolved[reference] = specs[index];
    }
  });
  return resolved;
}

/** Spawn bridges for unclaimed user_device environments and route each one to its bridge; caller overrides win. */
export async function _localize(
  options: ClientOptions,
  runtime: LocalRuntime | undefined,
  request: CreateSessionRequest,
  resolved: Resolved,
  bridgeOptions?: AutoBridgeOptions,
): Promise<PlaywrightBrowserBridge[]> {
  const body = request.body;
  _warnIfOverridesTargetUserDevice(body);
  const overrides = body.overrides ?? {};
  let apiKey: string;
  let baseUrl: string;
  let fetch: typeof globalThis.fetch | undefined;
  if (runtime === undefined) {
    apiKey = await _resolveToken(options);
    baseUrl = await _baseUrl(options);
  } else {
    apiKey = runtime.apiKey;
    baseUrl = runtime.baseUrl;
    fetch = runtime.fetch;
  }
  const idempotencyKey = request.idempotencyKey;
  const localized = localizeAgent(body.agent, {
    apiKey,
    baseUrl,
    fetch,
    resolved,
    claimed: Object.keys(overrides),
    seed: idempotencyKey == null ? undefined : `${_caller(apiKey, baseUrl)}:${idempotencyKey}`,
    bridgeOptions,
  });
  body.agent = localized.agent as SessionRequestAgent;
  if (Object.keys(localized.overrides).length > 0) {
    body.overrides = { ...localized.overrides, ...overrides };
  }
  // Python flags verify_runtime on each bridge here; the runtime's proof-checking fetch went in at construction.
  return localized.bridges;
}

/**
 * Watches bridges from startup on and runs a cancel action on the first loss, exactly once,
 * whether that loss lands before or after the action is attached. No lock: one event loop.
 */
class _LossWatcher {
  #lost = false;
  #action: (() => Promise<void>) | null = null;

  constructor(bridges: readonly PlaywrightBrowserBridge[]) {
    for (const bridge of bridges) {
      bridge.onCrash = () => this._fire();
    }
  }

  private _fire(): Promise<void> {
    if (this.#lost) {
      return Promise.resolve();
    }
    this.#lost = true;
    const action = this.#action;
    return action !== null ? action() : Promise.resolve();
  }

  /** Arm the action for future losses; true when one already landed, so the caller runs it. */
  attach(action: () => Promise<void>): boolean {
    if (this.#lost) {
      return true;
    }
    this.#action = action;
    return false;
  }
}

type RemoteCancel = (sessionId: string) => Promise<void>;

/** A bridge that dies mid-session leaves the agent without local control; cancel the session then. */
function _cancelAction(
  cancelRemote: RemoteCancel,
  bridges: readonly PlaywrightBrowserBridge[],
  session: { id?: string } | undefined,
): (() => Promise<void>) | null {
  const sessionId = session?.id;
  if (sessionId == null) {
    return null;
  }

  return async function cancel(): Promise<void> {
    logger.error(`local bridge for session ${sessionId} crashed; cancelling the session`);
    _deregisterExitCancel(sessionId);
    try {
      await cancelRemote(sessionId);
    } catch (error) {
      logger.error(`failed to cancel session ${sessionId} after its local bridge crashed`, error);
    } finally {
      await stopBridges(bridges.map((bridge) => bridge.sessionId));
    }
  };
}

/** Cancel over a fresh client, so it works at process exit, whatever happened to the caller's. */
async function _cancelRemoteSession(options: ClientOptions, runtime: LocalRuntime | undefined, sessionId: string): Promise<void> {
  const client =
    runtime !== undefined
      ? new BaseClient({ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, fetch: runtime.fetch })
      : new BaseClient({ baseUrl: await _baseUrl(options), apiKey: await _resolveToken(options), timeoutInSeconds: REMOTE_CANCEL_TIMEOUT_S });
  await client.sessions.cancelSession({ id: sessionId });
}

// Sessions that depend on this process's bridges, cancelled at process exit: the bridges die
// with the process, so leaving those sessions running only burns steps against a dead channel.
// Python's atexit also runs on an uncaught exception, SIGINT and sys.exit(); Node's beforeExit runs
// once the event loop drains, which an exit() call or a signal skips, so this is best effort.
export const _exitCancels = new Map<string, () => Promise<void>>();
let _exitHookArmed = false;

function _registerExitCancel(cancelRemote: RemoteCancel, sessionId: string): void {
  async function cancelQuietly(): Promise<void> {
    // Best effort: the session may have finished long ago; the platform rejects the cancel then.
    try {
      await cancelRemote(sessionId);
      logger.info(`cancelled session ${sessionId} at exit: its local bridge lives in this process`);
    } catch (error) {
      logger.debug(`exit-time cancel of session ${sessionId} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  _exitCancels.set(sessionId, cancelQuietly);
  // Python registers its atexit hook at import; the hook is armed on first use here, so importing the entry has no side effect.
  if (!_exitHookArmed) {
    _exitHookArmed = true;
    process.on("beforeExit", () => void _cancelSessionsAtExit());
  }
}

function _deregisterExitCancel(sessionId: string): void {
  _exitCancels.delete(sessionId);
}

export async function _cancelSessionsAtExit(): Promise<void> {
  const cancels = [..._exitCancels.values()];
  _exitCancels.clear();
  for (const cancel of cancels) {
    await cancel();
  }
}

// The session already ended or is gone: nothing left to stop.
export const STOPPED_CANCEL_STATUSES: ReadonlySet<number> = new Set([404, 409]);

function _alreadyStopped(error: unknown): boolean {
  return error instanceof HaiAgentsError && error.statusCode !== undefined && STOPPED_CANCEL_STATUSES.has(error.statusCode);
}

/** Keep the exit retry registered until the platform confirms the session stopped or had already ended. */
async function _confirmingStop(sessionId: string, cancel: () => Promise<void>): Promise<void> {
  try {
    await cancel();
  } catch (error) {
    if (_alreadyStopped(error)) {
      _deregisterExitCancel(sessionId);
    }
    throw error;
  }
  _deregisterExitCancel(sessionId);
}

/** Cancel errors collected while closing; a session that already ended is not a failure. */
class _CloseFailures {
  readonly #errors: unknown[] = [];

  async cancelling(cancel: () => Promise<void>): Promise<void> {
    try {
      await cancel();
    } catch (error) {
      if (!_alreadyStopped(error)) {
        this.#errors.push(error);
      }
    }
  }

  raiseAny(): void {
    if (this.#errors.length > 0) {
      throw new Error("Could not confirm all client-owned sessions stopped", { cause: this.#errors[0] });
    }
  }
}

export interface LocalSessionsOptions {
  /** The runtime the sessions run on, for a client from `Client.local()`; none for H's cloud. */
  runtime?: LocalRuntime;
  /** Start a bridge here for each user_device environment (default true), with a product's options when an object; `HAI_AUTO_BRIDGE=0` turns it off at runtime. */
  autoBridges?: AutoBridges;
}

export class LocalSessionsClient extends SessionsClient {
  private readonly _runtime: LocalRuntime | undefined;
  private readonly _autoBridges: AutoBridges;
  private _ownedBridges = new Map<string, string[]>();
  private _served = new Map<string, PlaywrightBrowserBridge[]>();
  // Sessions whose bridges stopped because they ended or were cancelled; a message restarts the session, so it
  // serves them again.
  private _stopped = new Map<string, PlaywrightBrowserBridge[]>();

  constructor(options: ClientOptions, { runtime, autoBridges = true }: LocalSessionsOptions = {}) {
    super(options);
    this._runtime = runtime;
    this._autoBridges = autoBridges;
  }

  /** Kinds of the environments this client serves from this machine for `sessionId`. */
  bridgedKinds(sessionId: string): string[] {
    const bridges = this._served.get(sessionId) ?? this._stopped.get(sessionId) ?? [];
    return bridges.map((bridge) => bridge.environmentKind);
  }

  /** Bridges a stopped session needs again; kept for the retry if the follow-up fails. */
  private async _reviving<T>(sessionId: string, follow: (bridges: PlaywrightBrowserBridge[]) => Promise<T>): Promise<T> {
    const bridges = this._stopped.get(sessionId) ?? [];
    this._stopped.delete(sessionId);
    try {
      return await follow(bridges);
    } catch (error) {
      if (bridges.length > 0) {
        this._stopped.set(sessionId, bridges);
      }
      throw error;
    }
  }

  /** Its bridges stopped; keep them for a follow-up, which restarts the session. */
  private _retire(sessionId: string): void {
    this._ownedBridges.delete(sessionId);
    const served = this._served.get(sessionId);
    if (served !== undefined) {
      this._served.delete(sessionId);
      this._stopped.set(sessionId, served);
    }
  }

  /** Bound to the runtime of the moment, so an exit cancel reaches the runtime its session lives on. */
  private get _cancelRemote(): RemoteCancel {
    return (sessionId) => _cancelRemoteSession(this._options, this._runtime, sessionId);
  }

  /** Forget sessions whose bridges all stopped, since each such stop already ended or cancelled its session. */
  private _liveSessions(): string[] {
    for (const [sessionId, bridgeIds] of [...this._ownedBridges]) {
      if (servingBridges(bridgeIds).length === 0) {
        this._ownedBridges.delete(sessionId);
        _deregisterExitCancel(sessionId);
      }
    }
    return [...this._ownedBridges.keys()];
  }

  /** The bridges to stop when `status` shows the session ended; an ended session needs no exit cancel. */
  private _endedBridges(sessionId: string, status: SessionStatus): string[] {
    if (!isTerminalSessionStatus(status.status)) {
      return [];
    }
    _deregisterExitCancel(sessionId);
    return this._ownedBridges.get(sessionId) ?? [];
  }

  /** An unconfirmed stop stays owned, so close() retries it. */
  private async _stopEnded(sessionId: string, owned: string[]): Promise<void> {
    try {
      await stopBridges(owned);
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        throw error;
      }
      logger.warn(`could not confirm local bridges stopped for ended session ${sessionId}`, error);
      return;
    }
    this._retire(sessionId);
  }

  private _track(session: { id?: string } | undefined, bridges: PlaywrightBrowserBridge[], started: string[]): void {
    const sessionId = session?.id;
    if (sessionId == null) {
      return;
    }
    if (started.length > 0) {
      this._ownedBridges.set(sessionId, started);
    }
    if (bridges.length > 0) {
      this._served.set(sessionId, bridges);
    }
  }

  /** Arm the crash and exit cancels of `session`; returns a stop that already landed and must run now. */
  private _guard(
    session: { id?: string } | undefined,
    bridges: readonly PlaywrightBrowserBridge[],
    watcher: _LossWatcher,
  ): (() => Promise<void>) | null {
    const cancel = _cancelAction(this._cancelRemote, bridges, session);
    if (cancel === null) {
      return null;
    }
    if (watcher.attach(cancel)) {
      return cancel;
    }
    _registerExitCancel(this._cancelRemote, session!.id!);
    // Python returns _panic_stop here when the kill switch fired while bridges or the session were starting: cut.
    return null;
  }

  /** Cancel the sessions this client bridges that are still served. */
  async close(): Promise<void> {
    const failures = new _CloseFailures();
    for (const sessionId of this._liveSessions()) {
      await failures.cancelling(() => this.cancelSession({ id: sessionId }));
    }
    failures.raiseAny();
  }

  override cancelSession(request: CancelSessionRequest, requestOptions?: RequestOptions): ReturnType<Sessions["cancelSession"]> {
    return HttpResponsePromise.fromPromise(this.#cancelSession(request, requestOptions)) as ReturnType<Sessions["cancelSession"]>;
  }

  async #cancelSession(request: CancelSessionRequest, requestOptions?: RequestOptions): Promise<WithRaw<ReturnType<Sessions["cancelSession"]>>> {
    const id = request.id;
    // Stop local execution even if the remote cancellation cannot be delivered.
    const owned = this._ownedBridges.get(id) ?? [];
    let response!: WithRaw<ReturnType<Sessions["cancelSession"]>>;
    try {
      if (owned.length > 0) {
        await stopBridges(owned);
      }
      this._retire(id);
    } finally {
      await _confirmingStop(id, async () => {
        response = await super.cancelSession(request, requestOptions).withRawResponse();
      });
    }
    return response;
  }

  override getSessionStatus(request: GetSessionStatusRequest, requestOptions?: RequestOptions): ReturnType<Sessions["getSessionStatus"]> {
    return HttpResponsePromise.fromPromise(this.#getSessionStatus(request, requestOptions)) as ReturnType<Sessions["getSessionStatus"]>;
  }

  async #getSessionStatus(request: GetSessionStatusRequest, requestOptions?: RequestOptions): Promise<WithRaw<ReturnType<Sessions["getSessionStatus"]>>> {
    const response = await super.getSessionStatus(request, requestOptions).withRawResponse();
    const owned = this._endedBridges(request.id, response.data);
    if (owned.length > 0) {
      await this._stopEnded(request.id, owned);
    }
    return response;
  }

  override createSession(request: CreateSessionRequest, requestOptions?: RequestOptions): ReturnType<Sessions["createSession"]> {
    return HttpResponsePromise.fromPromise(this.#createSession(request, requestOptions)) as ReturnType<Sessions["createSession"]>;
  }

  async #createSession(request: CreateSessionRequest, requestOptions?: RequestOptions): Promise<WithRaw<ReturnType<Sessions["createSession"]>>> {
    // Python re-acquires the runtime hold here: no re-acquire in TS (runtime.ts).
    // Python edits its own kwargs dict; the caller's request is copied so it stays untouched.
    request = { ...request, body: { ...request.body } };
    let bridges: PlaywrightBrowserBridge[] = [];
    if (_wantsBridges(this._autoBridges, request.body)) {
      bridges = await _localize(this._options, this._runtime, request, await _resolveReferences(this._options, request.body.agent), _bridgeOptions(this._autoBridges));
    }
    if (bridges.length > 0) {
      _applyRunawayBudgets(request.body);
    }
    // Python arms the kill switch (_ensure_stop_watcher) and runs each bridge's preflight here: cut.
    const watcher = new _LossWatcher(bridges);
    const started = await ensureBridges(bridges);
    let response: WithRaw<ReturnType<Sessions["createSession"]>>;
    try {
      response = await super.createSession(request, requestOptions).withRawResponse();
    } catch (error) {
      await _stopBridgesKeepingError(started);
      throw error;
    }
    const session: Session | undefined = response.data;
    if (bridges.length > 0) {
      const landed = this._guard(session, bridges, watcher);
      if (landed !== null) {
        await landed();
      }
    }
    this._track(session, bridges, started);
    return response;
  }

  override sendSessionMessages(request: SendSessionMessagesRequest, requestOptions?: RequestOptions): ReturnType<Sessions["sendSessionMessages"]> {
    return HttpResponsePromise.fromPromise(this.#sendSessionMessages(request, requestOptions)) as ReturnType<Sessions["sendSessionMessages"]>;
  }

  async #sendSessionMessages(request: SendSessionMessagesRequest, requestOptions?: RequestOptions): Promise<WithRaw<ReturnType<Sessions["sendSessionMessages"]>>> {
    const id = request.id;
    let watcher: _LossWatcher | undefined;
    let started: string[] = [];
    let response!: WithRaw<ReturnType<Sessions["sendSessionMessages"]>>;
    const bridges = await this._reviving(id, async (bridges) => {
      if (bridges.length > 0) {
        watcher = new _LossWatcher(bridges);
        started = await ensureBridges(bridges);
      }
      try {
        response = await super.sendSessionMessages(request, requestOptions).withRawResponse();
      } catch (error) {
        await _stopBridgesKeepingError(started);
        throw error;
      }
      return bridges;
    });
    if (bridges.length > 0) {
      const session = { id };
      const landed = this._guard(session, bridges, watcher!);
      if (landed !== null) {
        await landed();
      }
      this._track(session, bridges, started);
    }
    return response;
  }
}
