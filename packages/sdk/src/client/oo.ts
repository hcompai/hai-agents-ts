import { HaiAgentsClient as FernClient } from "./Client.js";
import { SessionsClient } from "./api/resources/sessions/client/Client.js";
import { HttpResponsePromise } from "./core/index.js";
import { HaiAgentsEnvironment } from "./environments.js";
import {
  SessionHandle,
  assertRequestUnderLimit,
  attachAnswerSchema,
  attachToolDefinitions,
  runSession,
  toCreateRequest,
  type AnswerSchema,
  type CreateSessionParams,
  type RunSessionOptions,
  type SessionRunResult,
} from "./polling.js";
import type {
  CancelSessionRequest,
  CreateSessionRequest,
  GetSessionStatusRequest,
  SendSessionMessagesRequest,
  Session,
  SessionChanges,
  SessionStatus,
} from "./api/index.js";
import { asTools, type Tool } from "./tools.js";
// Type-only, erased at build, as client.py's TYPE_CHECKING import of hai_agents_local: the browser-safe main entry never loads the Node-only local entry. From local/types.ts, which imports neither Node nor Playwright, so this entry's typings stay free of both.
import type { AutoBridges, LocalClientOptions, LocalEntry, LocalRuntime, LocalSessions } from "../local/types.js";

/** Python's hai_agents_local imports anywhere; the local entry spawns processes, so only Node.js can load it. */
const isNode = (): boolean => typeof process !== "undefined" && process.versions?.node != null;

// A variable specifier, as browser.ts loads hai-drivers: neither tsc nor a browser bundler follows it; it resolves through the package's own exports (a `require` in the CJS build: scripts/link-local-entry.mjs), and vitest maps it to the source.
const LOCAL_ENTRY = "hai-agents/local";

/** The local entry (`hai-agents/local`), loaded on first use. */
async function loadLocal(): Promise<LocalEntry> {
  return import(/* @vite-ignore */ LOCAL_ENTRY);
}

/** Node's ESM loader, its CJS loader and a bundler's runtime name a specifier they cannot resolve with these codes. */
function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

let warnedNoLocalEntry = false;

/**
 * `client.sessions` under Node: the generated client, with the four methods `LocalSessionsClient`
 * overrides delegated to it once the local entry has loaded. Python's `sessions` is the local
 * client itself (hai_agents_local ships with the package); the load is async here, so a subclass
 * stands in, and keeps `instanceof SessionsClient` and a stub assigned to a method working as on
 * the generated client.
 */
class LazyLocalSessionsClient extends SessionsClient {
  constructor(
    options: SessionsClient.Options,
    /** The loaded client; undefined where the local entry cannot be resolved, so the generated method serves. */
    private readonly _local: Promise<LocalSessions | undefined>,
  ) {
    super(options);
  }

  override createSession(request: CreateSessionRequest, requestOptions?: SessionsClient.RequestOptions): HttpResponsePromise<Session> {
    return this.#viaLocal((local) => local.createSession(request, requestOptions), () => super.createSession(request, requestOptions));
  }

  override cancelSession(request: CancelSessionRequest, requestOptions?: SessionsClient.RequestOptions): HttpResponsePromise<void> {
    return this.#viaLocal((local) => local.cancelSession(request, requestOptions), () => super.cancelSession(request, requestOptions));
  }

  override getSessionStatus(request: GetSessionStatusRequest, requestOptions?: SessionsClient.RequestOptions): HttpResponsePromise<SessionStatus> {
    return this.#viaLocal((local) => local.getSessionStatus(request, requestOptions), () => super.getSessionStatus(request, requestOptions));
  }

  override sendSessionMessages(request: SendSessionMessagesRequest, requestOptions?: SessionsClient.RequestOptions): HttpResponsePromise<void> {
    return this.#viaLocal((local) => local.sendSessionMessages(request, requestOptions), () => super.sendSessionMessages(request, requestOptions));
  }

  /** Each call waits for the load. The `HttpResponsePromise` unwraps lazily, so a failure the caller takes through `.withRawResponse()` is not also an unhandled rejection. */
  #viaLocal<T>(local: (sessions: LocalSessions) => HttpResponsePromise<T>, generated: () => HttpResponsePromise<T>): HttpResponsePromise<T> {
    return HttpResponsePromise.fromPromise(this._local.then((sessions) => (sessions === undefined ? generated() : local(sessions)).withRawResponse()));
  }
}

/**
 * The public SDK client, `Client` as in hai-agents-python. Extends the Fern-generated
 * client with create-and-run convenience methods (`runSession`, `startSession`,
 * `session`) that delegate to the hand-written polling helpers, and with `Client.local()`,
 * the same client bound to the agent runtime on this machine.
 */
export class Client extends FernClient {
  /** Python's `_hold`: the runtime behind a `Client.local()` client, and whether this client stops it; the local entry sets it. */
  // Python's hold also re-acquires a lost runtime; no re-acquire in TS (runtime.ts).
  _hold?: { runtime: LocalRuntime; owned: boolean };

  /** The runtime on this machine, for a client from `Client.local()`; none for H's cloud. */
  get localRuntime(): LocalRuntime | undefined {
    return this._hold?.runtime;
  }

  /** Start a bridge on this machine for each `user_device` environment of a session (default true; Node only); an object adds a product's options to each bridge. */
  // ts-ahead: Python's auto_bridges is a bool; the object form carries per-environment bridge options (local/routing.ts).
  readonly autoBridges: AutoBridges;
  private _localSessions?: Promise<LocalSessions | undefined>;

  constructor(options: Client.Options = {}) {
    // Python's auto_bridges is a Client.local() argument (Client() always bridges); a constructor option here, so a cloud client can turn its bridges off too.
    const { autoBridges = true, ...client } = options;
    // Python resolves api_key as argument, then HAI_API_KEY, then the key `holo login` stored, and raises "No API key found..." here; TS keeps Fern's BearerAuthProvider (argument, then HAI_API_KEY at the first request): no credentials store, the browser-safe main entry cannot read files.
    // Pin the default the per-resource calls already use, so passthrough `fetch` can resolve relative paths.
    super(
      client.baseUrl == null && client.environment == null
        ? { ...client, environment: HaiAgentsEnvironment.Eu }
        : client,
    );
    this.autoBridges = autoBridges;
  }

  /** The sessions client that starts a bridge on this machine for each `user_device` environment. */
  // Python's is always the local one (hai_agents_local ships with the package); the bridge layer needs Node, so it loads on first use there, and a browser keeps the generated client.
  public override get sessions(): SessionsClient {
    if (this._sessions === undefined && this.autoBridges && isNode()) {
      this._localSessions = loadLocal().then(
        (local) => new local.LocalSessionsClient(this._options, { runtime: this.localRuntime, autoBridges: this.autoBridges }),
        (error) => {
          // A bundler that inlined the SDK leaves no package to resolve the entry from: the generated client serves, without bridges, and says so once.
          if (!isModuleNotFound(error)) {
            throw error;
          }
          if (!warnedNoLocalEntry) {
            warnedNoLocalEntry = true;
            console.warn(`hai-agents: cannot load '${LOCAL_ENTRY}' from this bundle, so no bridge starts on this machine for user_device environments; pass autoBridges: false to the client to silence this warning`);
          }
          return undefined;
        },
      );
      // A broken install rejects before any method is called; the tap keeps Node from reporting an unhandled rejection, and each call still rejects with it.
      this._localSessions.catch(() => undefined);
      this._sessions = new LazyLocalSessionsClient(this._options, this._localSessions);
    }
    return super.sessions;
  }

  /**
   * A client on a local agent runtime: `runtime` if given, else one this client starts and owns.
   *
   * Node.js only. The runtime binary is never downloaded on its own: pass `{ download: true }`
   * the first time, or put `hai-agent-runtime` on PATH.
   */
  // Python's classmethod builds `cls(...)`; the `this` parameter types a subclass the same way.
  static async local<T extends Client>(this: new (options?: Client.Options) => T, options: LocalClientOptions = {}): Promise<T> {
    if (!isNode()) {
      throw new Error("Client.local() needs Node.js: the local runtime runs on this machine");
    }
    return (await loadLocal()).local(options, this);
  }

  /** `await using client = await Client.local()`: Python's `with Client.local() as client:` (`__exit__` is `close()`); the async disposable is the TS idiom. */
  // Node 20.4+ has `Symbol.asyncDispose` (its typing comes with @types/node); before it, `await using` cannot run either. The built typings reference the `esnext.disposable` lib for consumers without @types/node (scripts/link-local-entry.mjs).
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** Stop the sessions this client bridged; a `Client.local()` client also stops the runtime it started. A runtime also exits on its own when the process that started it does. */
  async close(): Promise<void> {
    try {
      // Nothing local to close where the local entry could not be resolved (the generated client served).
      const local = this._localSessions === undefined ? undefined : await this._localSessions;
      if (local !== undefined) {
        await local.close();
      }
    } finally {
      // Python stops the runtime only once no other client uses it (shutdown_if_idle); no idle check in TS (runtime.ts), so an owned runtime stops here. fetch has no connection pool to close.
      if (this._hold?.owned) {
        await this._hold.runtime.shutdown();
      }
    }
  }

  /** Create a session and resolve once it completes, returning the result and final answer. */
  public runSession<TAnswer = SessionChanges["answer"]>(
    options: RunSessionOptions<TAnswer>,
  ): Promise<SessionRunResult<TAnswer>> {
    return runSession(this, options);
  }

  /** Create a session and return a handle to it without waiting. */
  public async startSession<TAnswer = SessionChanges["answer"]>(
    params: CreateSessionParams & { answerSchema?: AnswerSchema<TAnswer>; tools?: readonly Tool[] },
  ): Promise<SessionHandle<TAnswer>> {
    const { answerSchema, tools, ...createParams } = params;
    const normalizedTools = asTools(tools ?? []);
    const withTools =
      normalizedTools.length > 0 ? attachToolDefinitions(createParams, normalizedTools) : createParams;
    const prepared = answerSchema ? await attachAnswerSchema(withTools, answerSchema) : withTools;
    assertRequestUnderLimit(prepared);
    const session = await this.sessions.createSession(toCreateRequest(prepared));
    return new SessionHandle(this, session.id, answerSchema, normalizedTools.length > 0 ? normalizedTools : undefined);
  }

  /** Wrap an existing session id in a handle. */
  public session(id: string): SessionHandle {
    return new SessionHandle(this, id);
  }
}

export namespace Client {
  export type Options = FernClient.Options & {
    /** Start a bridge on this machine for each `user_device` environment of a session (default true), with a product's options when an object; `HAI_AUTO_BRIDGE=0` turns it off at runtime. */
    autoBridges?: AutoBridges;
  };
  export type RequestOptions = FernClient.RequestOptions;
}

/** @deprecated Use Client. */
export const HaiAgentsClient = Client;
/** @deprecated Use Client. */
export type HaiAgentsClient = Client;
/** @deprecated Use Client. */
export namespace HaiAgentsClient {
  export type Options = Client.Options;
  export type RequestOptions = Client.RequestOptions;
}
