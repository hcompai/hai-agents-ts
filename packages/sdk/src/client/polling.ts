import type { HaiAgentsClient } from "./Client.js";
import type {
  CreateSessionRequest,
  GetSessionChangesRequest,
  SendSessionMessagesRequest,
  Session,
  SessionRequest,
  SessionStatus,
  TrajectoryChanges,
  TrajectoryEvent,
  TrajectoryStatus,
} from "./api/index.js";
import { asTools, toolDefinition, type Tool } from "./tools.js";

export const TERMINAL_SESSION_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "interrupted",
] as const satisfies readonly TrajectoryStatus[];

/** Server rejects request bodies above this size; enforced client-side for a clear early error. */
export const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export type SessionRunResult<TAnswer = TrajectoryChanges["answer"]> = {
  id: string;
  status: TrajectoryStatus;
  events: TrajectoryEvent[];
  nextFromIndex: number;
  finalChanges?: TrajectoryChanges;
  /**
   * The session's final answer: the parsed `answerSchema` value when one was requested and
   * the session completed, otherwise the raw wire value (also at `finalChanges.answer`).
   */
  answer?: TAnswer;
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
export class AnswerValidationError extends Error {
  constructor(
    public readonly raw: unknown,
    cause: unknown,
  ) {
    super(`Final answer does not match the requested answerSchema: ${cause}`);
    this.name = "AnswerValidationError";
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
  const agent = params.agent;
  if (typeof agent === "string") {
    const overrides: Record<string, unknown> = { ...(params.overrides ?? {}) };
    if (overrides["agent.answer_format"] != null) {
      throw new Error("answerSchema conflicts with overrides['agent.answer_format']; pass only one.");
    }
    overrides["agent.answer_format"] = jsonSchema;
    return { ...params, overrides };
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
  raw: TrajectoryChanges["answer"] | undefined,
  status: TrajectoryStatus,
  schema: AnswerSchema<TAnswer> | undefined,
): TAnswer | undefined {
  if (schema === undefined || status !== "completed") {
    return raw as TAnswer | undefined;
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

export type WaitForSessionOptions<TAnswer = TrajectoryChanges["answer"]> = {
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

export type RunSessionOptions<TAnswer = TrajectoryChanges["answer"]> = CreateSessionParams & {
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

export function assertRequestUnderLimit(payload: unknown, maxBytes: number = MAX_REQUEST_BYTES): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {})).length;
  if (bytes > maxBytes) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
    throw new Error(
      `Request payload is ${mb(bytes)}MB, over the ${mb(maxBytes)}MB limit. Downscale images before sending.`,
    );
  }
}

/** Carry the tool definitions via the `agent.tools` override; the server applies it to referenced and inline agents alike. */
export function attachToolDefinitions(params: CreateSessionParams, tools: readonly Tool[]): CreateSessionParams {
  return { ...params, overrides: { ...(params.overrides ?? {}), "agent.tools": tools.map(toolDefinition) } };
}

type PendingToolCall = { id: string; name: string; arguments?: Record<string, unknown> };

/**
 * Pending custom tool calls per the latest `ActiveStateChangeEvent`.
 *
 * The agent re-publishes the surviving list whenever a call settles, so the latest
 * event is the source of truth; `previous` carries it across polls whose batches
 * contain no state change.
 */
function latestPendingToolCalls(
  batch: readonly TrajectoryEvent[],
  previous: PendingToolCall[],
): PendingToolCall[] {
  let calls = previous;
  for (const event of batch) {
    if (event.type !== "ActiveStateChangeEvent") {
      continue;
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    calls =
      data["state"] === "awaiting_tool_results"
        ? [...((data["pending_tool_calls"] ?? []) as PendingToolCall[])]
        : [];
  }
  return calls;
}

function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value === undefined ? null : value;
  } catch {
    return String(value);
  }
}

type ToolResultPayload = { type: "tool_result"; tool_call_id: string; result: unknown; is_error: boolean };

/** Run one pending call locally and shape the `tool_result` payload. */
async function executeToolCall(
  toolsByName: ReadonlyMap<string, Tool>,
  call: PendingToolCall,
): Promise<ToolResultPayload> {
  const localTool = toolsByName.get(call.name);
  if (localTool === undefined) {
    return {
      type: "tool_result",
      tool_call_id: call.id,
      result: `Tool ${JSON.stringify(call.name)} is not registered with this client.`,
      is_error: true,
    };
  }
  try {
    const result = await localTool.fn(call.arguments ?? {});
    return { type: "tool_result", tool_call_id: call.id, result: jsonSafe(result), is_error: false };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { type: "tool_result", tool_call_id: call.id, result: message, is_error: true };
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
async function finalChanges(
  client: HaiAgentsClient,
  id: string,
  lastChanges: TrajectoryChanges | undefined,
  limit: number | null | undefined,
): Promise<TrajectoryChanges | undefined> {
  if (lastChanges && lastChanges.answer != null) {
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

/** A wait that joins mid-stream may start past the advertising event; replay from 0 to find the latest batch. */
async function recoverPendingToolCalls(client: HaiAgentsClient, id: string): Promise<PendingToolCall[]> {
  const changes = await client.sessions.getSessionChanges({
    id,
    fromIndex: 0,
    includeEvents: true,
    waitForSeconds: 0,
  });
  return latestPendingToolCalls(changes?.newEvents ?? [], []);
}

/**
 * Poll a session until it reaches a terminal status.
 *
 * Terminal state is read from `/status` (authoritative); `/changes` only feeds events
 * and the final answer, since it 204s whenever no new events exist past `fromIndex` --
 * even after the session has finished.
 */
export async function waitForSession<TAnswer = TrajectoryChanges["answer"]>(
  client: HaiAgentsClient,
  options: WaitForSessionOptions<TAnswer>,
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
    tools,
  } = options;
  const toolsByName = new Map(asTools(tools ?? []).map((t) => [t.name, t]));
  if (toolsByName.size > 0 && !includeEvents) {
    throw new Error("tools require includeEvents=true: pending calls arrive on the event stream.");
  }
  const answered = new Set<string>();
  let advertised: PendingToolCall[] = [];
  const events: TrajectoryEvent[] = [];
  let nextFromIndex = fromIndex;
  let lastChanges: TrajectoryChanges | undefined;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  for (let polls = 0; maxPolls === undefined || polls < maxPolls; polls += 1) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`Session ${id} did not reach a terminal status within ${timeoutMs}ms`);
    }

    let batch: TrajectoryEvent[] = [];
    if (includeEvents) {
      const changes = await client.sessions.getSessionChanges({
        id,
        fromIndex: nextFromIndex,
        includeEvents: true,
        limit: limit ?? undefined,
        waitForSeconds,
      });
      if (changes) {
        lastChanges = changes;
        batch = changes.newEvents ?? [];
        events.push(...batch);
        nextFromIndex += batch.length;
      }
    }

    const { status } = await client.sessions.getSessionStatus({ id });
    if (isTerminalSessionStatus(status)) {
      const changes = await finalChanges(client, id, lastChanges, limit);
      const answer = parseAnswer(changes?.answer, status, answerSchema);
      return { id, status, events, nextFromIndex, finalChanges: changes, answer };
    }

    if (toolsByName.size > 0) {
      advertised = latestPendingToolCalls(batch, advertised);
      // Status gate: on a replayed stream the live status decides whether calls are still open.
      if ((status as string) === "awaiting_tool_results") {
        if (advertised.length === 0) {
          advertised = await recoverPendingToolCalls(client, id);
        }
        const calls = advertised.filter((call) => !answered.has(call.id));
        if (calls.length > 0) {
          const results = await Promise.all(calls.map((call) => executeToolCall(toolsByName, call)));
          await postToolResults(client, id, results);
          for (const call of calls) {
            answered.add(call.id);
          }
        }
      }
    }

    // The long-poll above paces the loop when streaming events; otherwise sleep.
    if (!includeEvents) {
      await sleep(pollBackoffMs || waitForSeconds * 1000);
    } else if (pollBackoffMs > 0) {
      await sleep(pollBackoffMs);
    }
  }

  throw new Error(`Session ${id} did not reach a terminal status before maxPolls=${maxPolls}`);
}

export async function runSession<TAnswer = TrajectoryChanges["answer"]>(
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

/** A created session bound to its client: object-oriented sugar over the polling helpers. */
export class SessionHandle<TAnswer = TrajectoryChanges["answer"]> {
  constructor(
    private readonly client: HaiAgentsClient,
    public readonly id: string,
    private readonly answerSchema?: AnswerSchema<TAnswer>,
    private readonly tools?: readonly Tool[],
  ) {}

  get(): Promise<Session> {
    return this.client.sessions.getSession({ id: this.id });
  }

  status(): Promise<SessionStatus> {
    return this.client.sessions.getSessionStatus({ id: this.id });
  }

  changes(options?: Omit<GetSessionChangesRequest, "id">): Promise<TrajectoryChanges | undefined> {
    return this.client.sessions.getSessionChanges({ id: this.id, ...options });
  }

  sendMessage(message: SendSessionMessagesRequest["body"]): Promise<void> {
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

  /** Block until the session reaches a terminal status; resolves with the result and final answer. */
  waitForCompletion(options?: Omit<WaitForSessionOptions<TAnswer>, "id">): Promise<SessionRunResult<TAnswer>> {
    return waitForSession(this.client, { id: this.id, answerSchema: this.answerSchema, tools: this.tools, ...options });
  }
}
