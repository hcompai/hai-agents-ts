import type { HaiAgentsClient } from "./Client.js";
import type {
  ActiveStateChangeData,
  CreateSessionRequest,
  FileContent,
  GetSessionChangesRequest,
  SendSessionMessagesRequest,
  Session,
  SessionRequest,
  SessionStatus,
  SessionChanges,
  SessionEvent,
  TrajectoryStatus,
} from "./api/index.js";
import { asTools, toolDefinition, type Tool } from "./tools.js";
import { HaiAgentsError, HaiAgentsTimeoutError } from "./errors/index.js";

export const TERMINAL_SESSION_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "interrupted",
] as const satisfies readonly TrajectoryStatus[];

// Polling also stops on "idle": the agent finished its turn and is waiting for the next
// user message, which a one-shot wait will never send.
export const SETTLED_SESSION_STATUSES = [
  ...TERMINAL_SESSION_STATUSES,
  "idle",
] as const satisfies readonly TrajectoryStatus[];

/** The API gateway rejects request bodies above this size; enforced client-side for a clear early error. */
export const MAX_REQUEST_BYTES = 10_000_000;

export type SessionRunResult<TAnswer = SessionChanges["answer"]> = {
  id: string;
  status: TrajectoryStatus;
  events: SessionEvent[];
  nextFromIndex: number;
  finalChanges?: SessionChanges;
  /**
   * The session's final answer: the parsed `answerSchema` value when one was requested and
   * the session completed or idled with an answer, otherwise the raw wire value (also at
   * `finalChanges.answer`).
   */
  answer?: TAnswer;
  /** Agent's self-assessed task outcome (`success`/`partial`/`infeasible`/`blocked`), when reported. */
  outcome?: SessionChanges["outcome"];
  /** Human-readable error message when the session failed or timed out. */
  error?: SessionChanges["error"];
  /** Machine-readable failure category when the session failed or timed out. */
  errorCode?: SessionChanges["errorCode"];
};

/**
 * Structural subset of a Zod v4 schema: anything with `parse` works for the read side,
 * but the create side converts to JSON Schema via zod's `toJSONSchema`, so pass a real
 * Zod v4 schema. Zod is an optional peer dependency, loaded only when this is used.
 */
export type AnswerSchema<TAnswer = unknown> = {
  parse(data: unknown): TAnswer;
};

/** The session's final answer did not match the requested `answerSchema`. */
export class AnswerValidationError extends HaiAgentsError {
  constructor(
    public readonly raw: unknown,
    cause: unknown,
  ) {
    super({ message: `Final answer does not match the requested answerSchema: ${cause}`, cause });
  }
}

async function answerJsonSchema(schema: AnswerSchema<unknown>): Promise<Record<string, unknown>> {
  const zod = (await import("zod").catch(() => undefined)) as
    | { toJSONSchema?: (s: unknown) => Record<string, unknown> }
    | undefined;
  if (!zod?.toJSONSchema) {
    throw new Error("answerSchema requires zod >= 4 (provides toJSONSchema); install it alongside the SDK.");
  }
  const jsonSchema = zod.toJSONSchema(schema);
  // sagent resolves the generated answer model by title; zod schemas are anonymous.
  if (typeof jsonSchema.title !== "string") {
    jsonSchema.title = "Answer";
  }
  return jsonSchema;
}

/** Bind the schema's JSON Schema as the agent's answer format. */
export async function attachAnswerSchema(
  params: CreateSessionParams,
  schema: AnswerSchema<unknown>,
): Promise<CreateSessionParams> {
  const jsonSchema = await answerJsonSchema(schema);
  if (params.overrides?.["agent.answer_format"] != null) {
    throw new Error("answerSchema conflicts with overrides['agent.answer_format']; pass only one.");
  }
  const agent = params.agent;
  if (typeof agent === "string") {
    return { ...params, overrides: { ...(params.overrides ?? {}), "agent.answer_format": jsonSchema } };
  }
  if (agent && typeof agent === "object") {
    if (agent.answerFormat != null) {
      throw new Error("answerSchema conflicts with agent.answerFormat; pass only one.");
    }
    return { ...params, agent: { ...agent, answerFormat: jsonSchema } };
  }
  throw new Error("answerSchema requires an agent reference on the request.");
}

function parseAnswer<TAnswer>(
  raw: SessionChanges["answer"] | undefined,
  status: TrajectoryStatus,
  schema: AnswerSchema<TAnswer> | undefined,
): TAnswer | undefined {
  if (schema === undefined || (status !== "completed" && status !== "idle")) {
    return raw as TAnswer | undefined;
  }
  // An idle session may legitimately have no answer yet; a completed one must parse.
  if (status === "idle" && raw == null) {
    return undefined;
  }
  // The wire answer may arrive as JSON text rather than an object.
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      candidate = raw;
    }
  }
  try {
    return schema.parse(candidate);
  } catch (error) {
    throw new AnswerValidationError(raw, error);
  }
}

/** Flat create-session parameters: the request body fields plus the idempotency key. */
export type CreateSessionParams = SessionRequest & {
  idempotencyKey?: string | null;
};

/** Split flat params into the nested { idempotencyKey, body } shape the generated client expects. */
export function toCreateRequest(params: CreateSessionParams): CreateSessionRequest {
  const { idempotencyKey, ...body } = params;
  return { idempotencyKey: idempotencyKey ?? undefined, body };
}

export type WaitForSessionOptions<TAnswer = SessionChanges["answer"]> = {
  id: string;
  fromIndex?: number;
  waitForSeconds?: number;
  limit?: number | null;
  /** Stream and accumulate trajectory events; set false to poll status only. */
  includeEvents?: boolean;
  /** Overall wall-clock budget; throws once exceeded. */
  timeoutMs?: number;
  /** Delay between polls, on top of the server long-poll wait. */
  pollBackoffMs?: number;
  maxPolls?: number;
  /** Zod v4 schema the completed answer is parsed into. */
  answerSchema?: AnswerSchema<TAnswer>;
  /** Custom tools to run when the agent calls them. */
  tools?: readonly Tool[];
};

export type RunSessionOptions<TAnswer = SessionChanges["answer"]> = CreateSessionParams & {
  waitForSeconds?: number;
  includeEvents?: boolean;
  timeoutMs?: number;
  pollBackoffMs?: number;
  maxPolls?: number;
  /** Zod v4 schema: sent as the agent's answer format, and the completed answer is parsed into it. */
  answerSchema?: AnswerSchema<TAnswer>;
  /** Custom tools to run when the agent calls them. */
  tools?: readonly Tool[];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const isTerminalSessionStatus = (status: TrajectoryStatus): boolean =>
  (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);

export const isSettledSessionStatus = (status: TrajectoryStatus): boolean =>
  (SETTLED_SESSION_STATUSES as readonly string[]).includes(status);

export function assertRequestUnderLimit(payload: unknown, maxBytes: number = MAX_REQUEST_BYTES): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {})).length;
  if (bytes > maxBytes) {
    const mb = (n: number) => (n / 1e6).toFixed(2);
    throw new Error(
      `Request payload is ${mb(bytes)}MB, over the ${mb(maxBytes)}MB limit. Downscale images or attach smaller files.`,
    );
  }
}

/** A file to attach to a user message, from a `Blob` or a browser `File`. */
export async function fileFromBlob(blob: Blob, name?: string): Promise<FileContent> {
  const fileName = name ?? (blob as { name?: string }).name;
  if (!fileName) {
    throw new Error("fileFromBlob needs a name for a Blob that is not a File");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { type: "base64", source: btoa(binary), name: fileName, mediaType: blob.type || undefined };
}

/**
 * A file to attach to a user message, read from disk; the platform guesses `mediaType` from the name when omitted.
 * Node's fs comes through `process.getBuiltinModule` so that a browser bundle pulls in no Node built-in.
 */
export async function fileFromPath(path: string, mediaType?: string): Promise<FileContent> {
  const load = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    ?.getBuiltinModule;
  if (load === undefined) {
    throw new Error("fileFromPath needs Node.js 20.16 or newer; use fileFromBlob in a browser");
  }
  const { readFile } = load("node:fs/promises") as typeof import("node:fs/promises");
  const { basename } = load("node:path") as typeof import("node:path");
  const bytes = await readFile(path);
  return { type: "base64", source: bytes.toString("base64"), name: basename(path), mediaType };
}

/** Carry the tool definitions via the `agent.tools` override; the server applies it to referenced and inline agents alike. */
export function attachToolDefinitions(params: CreateSessionParams, tools: readonly Tool[]): CreateSessionParams {
  return { ...params, overrides: { ...(params.overrides ?? {}), "agent.tools": tools.map(toolDefinition) } };
}

type PendingToolCall = { id?: string | null; tool_name: string; args?: Record<string, unknown> };

/** Dedup key for an advertised call: its id, or a content signature when id is null. */
function callKey(call: PendingToolCall): string {
  return call.id != null ? call.id : JSON.stringify({ tool_name: call.tool_name, args: call.args ?? {} });
}

/**
 * One loop's view of the pending custom tool calls, per the latest `ActiveStateChangeEvent`.
 *
 * The agent re-publishes the surviving list whenever a call settles and reports another
 * state once the last one resolves, so a stretch of `awaiting_tool_results` events is one
 * step's calls. `stretch` is the index of the event that opened it: every loop reading the
 * same log agrees on it, and it tells a reused call id (`xml_0`) apart from the same id in
 * a later step. `anchored` is whether this loop read the log from where the stretch could
 * have begun.
 */
class Advertised {
  stretch: number | null = null;
  calls: PendingToolCall[] = [];

  constructor(public anchored: boolean) {}

  /** Fold in `batch`, the events just before index `end`. */
  read(batch: readonly SessionEvent[], end: number): void {
    batch.forEach((event, offset) => {
      if (event.type !== "ActiveStateChangeEvent") {
        return;
      }
      // Events arrive through the serde layer, so data is camelCase (pendingToolCalls / toolName).
      const data = (event.data ?? {}) as ActiveStateChangeData;
      if (data.state === "awaiting_tool_results") {
        this.stretch ??= end - batch.length + offset;
        this.calls = (data.pendingToolCalls ?? []).map((c) => ({ id: c.id, tool_name: c.toolName, args: c.args }));
      } else {
        this.stretch = null;
        this.calls = [];
        this.anchored = true;
      }
    });
  }

  adopt(other: Advertised): void {
    this.stretch = other.stretch;
    this.calls = other.calls;
    this.anchored = other.anchored;
  }
}

function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value === undefined ? null : value;
  } catch {
    return String(value);
  }
}

type ToolReq = { tool_name: string; args: Record<string, unknown>; id: string | null };
type ToolResultPayload =
  | { kind: "tool_result"; tool_req: ToolReq; result: unknown }
  | { kind: "error_event"; error: string; origin: string; tool_req: ToolReq };

function toolReq(call: PendingToolCall): ToolReq {
  return { tool_name: call.tool_name, args: call.args ?? {}, id: call.id ?? null };
}

/** Run one pending call locally and shape the `tool_result` payload. */
async function executeToolCall(
  toolsByName: ReadonlyMap<string, Tool>,
  call: PendingToolCall,
): Promise<ToolResultPayload> {
  const localTool = toolsByName.get(call.tool_name);
  if (localTool === undefined) {
    return {
      kind: "error_event",
      error: `Tool ${JSON.stringify(call.tool_name)} is not registered with this client.`,
      origin: "client",
      tool_req: toolReq(call),
    };
  }
  try {
    const result = await localTool.fn(call.args ?? {});
    return { kind: "tool_result", tool_req: toolReq(call), result: jsonSafe(result) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { kind: "error_event", error: message, origin: "client", tool_req: toolReq(call) };
  }
}

async function postToolResults(client: HaiAgentsClient, id: string, results: ToolResultPayload[]): Promise<void> {
  const body = results.length === 1 ? results[0] : { type: "batch", results };
  const response = await client.fetch(`api/v2/sessions/${encodeURIComponent(id)}/tool_results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // 409 means the session finished and resolved the calls itself; the status poll will exit the loop.
  if (!(response.status >= 200 && response.status < 300) && response.status !== 409) {
    throw new Error(`Posting tool results to session ${id} failed: HTTP ${response.status} ${await response.text()}`);
  }
}

// The terminal answer lives in /changes; fetch it once if streaming didn't surface it.
// On failure statuses the error fields land after the last streamed poll, so always refetch.
async function finalChanges(
  client: HaiAgentsClient,
  id: string,
  lastChanges: SessionChanges | undefined,
  limit: number | null | undefined,
  status: TrajectoryStatus,
): Promise<SessionChanges | undefined> {
  const settledCleanly = status === "completed" || status === "idle";
  if (settledCleanly && lastChanges && lastChanges.answer != null) {
    return lastChanges;
  }
  const fetched = await client.sessions.getSessionChanges({
    id,
    fromIndex: 0,
    includeEvents: false,
    limit: limit ?? undefined,
    waitForSeconds: 0,
  });
  return fetched ?? lastChanges;
}

/** A loop that joins mid-stream may start past the advertising event; replay from 0 to find the latest batch. */
async function recoverPendingToolCalls(client: HaiAgentsClient, id: string): Promise<Advertised> {
  const changes = await client.sessions.getSessionChanges({
    id,
    fromIndex: 0,
    includeEvents: true,
    waitForSeconds: 0,
  });
  const events = changes?.newEvents ?? [];
  const replayed = new Advertised(true);
  replayed.read(events, (changes?.firstIndex ?? 0) + events.length);
  return replayed;
}

/** Custom tools plus the calls already claimed; a handle shares one across its waits and streams. */
class ToolDispatch {
  readonly toolsByName: ReadonlyMap<string, Tool>;
  private readonly claimed = new Set<string>();

  constructor(tools: readonly Tool[]) {
    this.toolsByName = new Map(asTools(tools).map((t) => [t.name, t]));
  }

  /** Return the advertised calls no loop has claimed yet, claiming them. */
  claim(advertised: Advertised): PendingToolCall[] {
    const key = (call: PendingToolCall) => JSON.stringify([advertised.stretch, callKey(call)]);
    const fresh = advertised.calls.filter((call) => !this.claimed.has(key(call)));
    for (const call of fresh) {
      this.claimed.add(key(call));
    }
    return fresh;
  }

  release(stretch: number | null, calls: readonly PendingToolCall[]): void {
    for (const call of calls) {
      this.claimed.delete(JSON.stringify([stretch, callKey(call)]));
    }
  }
}

function toolDispatch(tools: readonly Tool[] | undefined): ToolDispatch | undefined {
  return tools !== undefined && tools.length > 0 ? new ToolDispatch(tools) : undefined;
}

/** Only a short page proves the cursor reached the live tip; without a positive `limit` no page is full. */
function caughtUp(batch: readonly SessionEvent[], limit: number | null | undefined): boolean {
  return !limit || batch.length < limit;
}

/** Run and post the calls the session awaits, each once per step. */
async function answerToolCalls(
  client: HaiAgentsClient,
  id: string,
  dispatch: ToolDispatch,
  advertised: Advertised,
  status: TrajectoryStatus,
  isCaughtUp: boolean,
): Promise<void> {
  // The live status describes the tip: a lagging cursor's advertised calls may already be answered.
  if (!isCaughtUp || (status as string) !== "awaiting_tool_results") {
    return;
  }
  if (!advertised.anchored || advertised.calls.length === 0) {
    advertised.adopt(await recoverPendingToolCalls(client, id));
  }
  const calls = dispatch.claim(advertised);
  if (calls.length > 0) {
    try {
      const results = await Promise.all(calls.map((call) => executeToolCall(dispatch.toolsByName, call)));
      await postToolResults(client, id, results);
    } catch (error) {
      dispatch.release(advertised.stretch, calls);
      throw error;
    }
  }
}

/** Cursor past `changes`; starts at the server's `firstIndex` when it skipped evicted events. */
function cursorAfter(cursor: number, changes: SessionChanges | undefined): number {
  if (!changes) return cursor;
  const start = changes.firstIndex ?? cursor;
  if (start > cursor) console.warn(`Skipped ${start - cursor} session events evicted before they were read`);
  return start + (changes.newEvents?.length ?? 0);
}

/**
 * Poll a session until it settles: a terminal status, or idle awaiting the next message.
 * Without `tools`, a session awaiting tool results also ends the wait, since nothing here will answer it.
 *
 * Status is read from `/status` (authoritative); `/changes` only feeds events
 * and the final answer, since it 204s whenever no new events exist past `fromIndex` --
 * even after the session has finished.
 */
export function waitForSession<TAnswer = SessionChanges["answer"]>(
  client: HaiAgentsClient,
  options: WaitForSessionOptions<TAnswer>,
): Promise<SessionRunResult<TAnswer>> {
  return waitWithDispatch(client, options, toolDispatch(options.tools));
}

async function waitWithDispatch<TAnswer>(
  client: HaiAgentsClient,
  options: WaitForSessionOptions<TAnswer>,
  dispatch: ToolDispatch | undefined,
): Promise<SessionRunResult<TAnswer>> {
  const {
    id,
    fromIndex = 0,
    waitForSeconds = 20,
    limit,
    includeEvents = true,
    timeoutMs,
    pollBackoffMs = 0,
    maxPolls,
    answerSchema,
  } = options;
  const advertised = new Advertised(fromIndex === 0);
  if (dispatch !== undefined && !includeEvents) {
    throw new Error("tools require includeEvents=true: pending calls arrive on the event stream.");
  }
  const events: SessionEvent[] = [];
  let nextFromIndex = fromIndex;
  let lastChanges: SessionChanges | undefined;
  let isCaughtUp = true;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  for (let polls = 0; maxPolls === undefined || polls < maxPolls; polls += 1) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new HaiAgentsTimeoutError(`Session ${id} did not settle within ${timeoutMs}ms`);
    }

    let batch: SessionEvent[] = [];
    if (includeEvents) {
      const changes = await client.sessions.getSessionChanges({
        id,
        fromIndex: nextFromIndex,
        includeEvents: true,
        limit: limit ?? undefined,
        waitForSeconds: isCaughtUp ? waitForSeconds : 0,
      });
      if (changes) {
        lastChanges = changes;
        batch = changes.newEvents ?? [];
        events.push(...batch);
        nextFromIndex = cursorAfter(nextFromIndex, changes);
        advertised.read(batch, nextFromIndex);
      }
    }
    isCaughtUp = caughtUp(batch, limit);

    const statusResponse = await client.sessions.getSessionStatus({ id });
    const status = statusResponse.status;
    if (isSettledSessionStatus(status) || ((status as string) === "awaiting_tool_results" && dispatch === undefined)) {
      if (includeEvents) {
        for (;;) {
          if (deadline !== undefined && Date.now() >= deadline) {
            throw new HaiAgentsTimeoutError(`Session ${id} did not settle within ${timeoutMs}ms`);
          }
          const tail = await client.sessions.getSessionChanges({
            id,
            fromIndex: nextFromIndex,
            includeEvents: true,
            limit: limit ?? undefined,
            waitForSeconds: 0,
          });
          const drained = tail?.newEvents ?? [];
          if (drained.length === 0) break;
          if (tail?.answer != null) lastChanges = tail;
          events.push(...drained);
          nextFromIndex = cursorAfter(nextFromIndex, tail);
        }
      }
      const changes = await finalChanges(client, id, lastChanges, limit, status);
      const answer = parseAnswer(changes?.answer, status, answerSchema);
      // /status is authoritative for the failure fields: /changes 204s when a
      // session dies before emitting any visible event.
      return {
        id,
        status,
        events,
        nextFromIndex,
        finalChanges: changes,
        answer,
        outcome: statusResponse.outcome ?? changes?.outcome,
        error: statusResponse.error ?? changes?.error,
        errorCode: statusResponse.errorCode ?? changes?.errorCode,
      };
    }

    if (dispatch !== undefined) {
      await answerToolCalls(client, id, dispatch, advertised, status, isCaughtUp);
    }

    // The long-poll above paces the loop when streaming events; otherwise sleep.
    if (!includeEvents) {
      await sleep(pollBackoffMs || waitForSeconds * 1000);
    } else if (pollBackoffMs > 0) {
      await sleep(pollBackoffMs);
    }
  }

  throw new HaiAgentsTimeoutError(`Session ${id} did not settle before maxPolls=${maxPolls}`);
}

export async function runSession<TAnswer = SessionChanges["answer"]>(
  client: HaiAgentsClient,
  options: RunSessionOptions<TAnswer>,
): Promise<SessionRunResult<TAnswer>> {
  const { waitForSeconds, includeEvents, timeoutMs, pollBackoffMs, maxPolls, answerSchema, tools, ...createParams } =
    options;
  const normalizedTools = asTools(tools ?? []);
  const withTools =
    normalizedTools.length > 0 ? attachToolDefinitions(createParams, normalizedTools) : createParams;
  const params = answerSchema ? await attachAnswerSchema(withTools, answerSchema) : withTools;
  assertRequestUnderLimit(params);
  const session = await client.sessions.createSession(toCreateRequest(params));
  return waitForSession(client, {
    id: session.id,
    waitForSeconds,
    includeEvents,
    timeoutMs,
    pollBackoffMs,
    maxPolls,
    answerSchema,
    tools: normalizedTools,
  });
}

export type StreamSessionOptions = {
  id: string;
  fromIndex?: number;
  waitForSeconds?: number;
  limit?: number | null;
  /** Stop on "settled" (terminal or idle) or only on "terminal" (keeps the stream open across idle turns). */
  until?: "settled" | "terminal";
  /** Overall wall-clock budget; throws once exceeded. */
  timeoutMs?: number;
  /** Custom tools to run when the agent calls them. */
  tools?: readonly Tool[];
};

/**
 * Yield a session's events incrementally as they arrive, until it stops.
 *
 * Wraps the long-poll loop: each poll yields the events past the cursor, then the
 * loop reads the authoritative status and stops per `until` ("settled" = terminal
 * or idle; "terminal" keeps the stream open across the idle turns of an interactive
 * session). A final non-blocking drain loop flushes any backlog remaining when it
 * stops.
 *
 * With `tools`, each poll then runs the custom tool calls the session awaits and
 * posts their results. Without them the stream is a read-only view that keeps
 * polling through `awaiting_tool_results`, for calls another process answers.
 */
export function streamSession(client: HaiAgentsClient, options: StreamSessionOptions): AsyncGenerator<SessionEvent> {
  return streamWithDispatch(client, options, toolDispatch(options.tools));
}

async function* streamWithDispatch(
  client: HaiAgentsClient,
  options: StreamSessionOptions,
  dispatch: ToolDispatch | undefined,
): AsyncGenerator<SessionEvent> {
  const { id, fromIndex = 0, waitForSeconds = 20, limit, until = "settled", timeoutMs } = options;
  const shouldStop = until === "terminal" ? isTerminalSessionStatus : isSettledSessionStatus;
  const advertised = new Advertised(fromIndex === 0);
  let nextFromIndex = fromIndex;
  let isCaughtUp = true;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  for (;;) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new HaiAgentsTimeoutError(`Session ${id} did not settle within ${timeoutMs}ms`);
    }

    const changes = await client.sessions.getSessionChanges({
      id,
      fromIndex: nextFromIndex,
      includeEvents: true,
      limit: limit ?? undefined,
      waitForSeconds: isCaughtUp ? waitForSeconds : 0,
    });
    const batch = changes?.newEvents ?? [];
    yield* batch;
    nextFromIndex = cursorAfter(nextFromIndex, changes);
    advertised.read(batch, nextFromIndex);
    isCaughtUp = caughtUp(batch, limit);

    const { status } = await client.sessions.getSessionStatus({ id });
    if (shouldStop(status)) {
      // Drain to exhaustion: with `limit`, one page may not cover the backlog past the
      // cursor. Keep honoring the wall-clock budget so a large tail cannot outlive `timeoutMs`.
      for (;;) {
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new HaiAgentsTimeoutError(`Session ${id} did not settle within ${timeoutMs}ms`);
        }
        const tail = await client.sessions.getSessionChanges({
          id,
          fromIndex: nextFromIndex,
          includeEvents: true,
          limit: limit ?? undefined,
          waitForSeconds: 0,
        });
        const drained = tail?.newEvents ?? [];
        if (drained.length === 0) {
          return;
        }
        yield* drained;
        nextFromIndex = cursorAfter(nextFromIndex, tail);
      }
    }

    if (dispatch !== undefined) {
      await answerToolCalls(client, id, dispatch, advertised, status, isCaughtUp);
    }
  }
}

/** A created session bound to its client: object-oriented sugar over the polling helpers. */
export class SessionHandle<TAnswer = SessionChanges["answer"]> {
  private readonly dispatch: ToolDispatch | undefined;

  constructor(
    private readonly client: HaiAgentsClient,
    public readonly id: string,
    private readonly answerSchema?: AnswerSchema<TAnswer>,
    tools?: readonly Tool[],
  ) {
    this.dispatch = toolDispatch(tools);
  }

  get(): Promise<Session> {
    return this.client.sessions.getSession({ id: this.id });
  }

  status(): Promise<SessionStatus> {
    return this.client.sessions.getSessionStatus({ id: this.id });
  }

  changes(options?: Omit<GetSessionChangesRequest, "id">): Promise<SessionChanges | undefined> {
    return this.client.sessions.getSessionChanges({ id: this.id, ...options });
  }

  sendMessage(message: SendSessionMessagesRequest["body"]): Promise<void> {
    assertRequestUnderLimit(message);
    return this.client.sessions.sendSessionMessages({ id: this.id, body: message });
  }

  pause(): Promise<void> {
    return this.client.sessions.pauseSession({ id: this.id });
  }

  resume(): Promise<void> {
    return this.client.sessions.resumeSession({ id: this.id });
  }

  cancel(): Promise<void> {
    return this.client.sessions.cancelSession({ id: this.id });
  }

  forceAnswer(): Promise<void> {
    return this.client.sessions.forceSessionAnswer({ id: this.id });
  }

  /** Block until the session settles (terminal or idle); resolves with the result and final answer. */
  waitForCompletion(options?: Omit<WaitForSessionOptions<TAnswer>, "id">): Promise<SessionRunResult<TAnswer>> {
    const request = { id: this.id, answerSchema: this.answerSchema, ...options };
    return waitWithDispatch(this.client, request, this.dispatchFor(options?.tools));
  }

  /** Yield events until settled, running `tools` (default: the handle's); each call runs once per handle. */
  stream(options?: Omit<StreamSessionOptions, "id">): AsyncGenerator<SessionEvent> {
    return streamWithDispatch(this.client, { id: this.id, ...options }, this.dispatchFor(options?.tools));
  }

  private dispatchFor(tools: readonly Tool[] | undefined): ToolDispatch | undefined {
    return tools === undefined ? this.dispatch : toolDispatch(tools);
  }
}
