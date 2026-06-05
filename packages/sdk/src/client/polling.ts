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

export const TERMINAL_SESSION_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "interrupted",
] as const satisfies readonly TrajectoryStatus[];

/** Server rejects request bodies above this size; enforced client-side for a clear early error. */
export const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export type SessionRunResult = {
  id: string;
  status: TrajectoryStatus;
  events: TrajectoryEvent[];
  nextFromIndex: number;
  finalChanges?: TrajectoryChanges;
  /** The session's final answer, if it produced one (shortcut for finalChanges.answer). */
  answer?: TrajectoryChanges["answer"];
};

/** Flat create-session parameters: the request body fields plus the idempotency key. */
export type CreateSessionParams = SessionRequest & {
  idempotencyKey?: string | null;
};

/** Split flat params into the nested { idempotencyKey, body } shape the generated client expects. */
export function toCreateRequest(params: CreateSessionParams): CreateSessionRequest {
  const { idempotencyKey, ...body } = params;
  return { idempotencyKey: idempotencyKey ?? undefined, body };
}

export type WaitForSessionOptions = {
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
};

export type RunSessionOptions = CreateSessionParams & {
  waitForSeconds?: number;
  includeEvents?: boolean;
  timeoutMs?: number;
  pollBackoffMs?: number;
  maxPolls?: number;
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

/**
 * Poll a session until it reaches a terminal status.
 *
 * Terminal state is read from `/status` (authoritative); `/changes` only feeds events
 * and the final answer, since it 204s whenever no new events exist past `fromIndex` --
 * even after the session has finished.
 */
export async function waitForSession(
  client: HaiAgentsClient,
  options: WaitForSessionOptions,
): Promise<SessionRunResult> {
  const {
    id,
    fromIndex = 0,
    waitForSeconds = 20,
    limit,
    includeEvents = true,
    timeoutMs,
    pollBackoffMs = 0,
    maxPolls,
  } = options;
  const events: TrajectoryEvent[] = [];
  let nextFromIndex = fromIndex;
  let lastChanges: TrajectoryChanges | undefined;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  for (let polls = 0; maxPolls === undefined || polls < maxPolls; polls += 1) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`Session ${id} did not reach a terminal status within ${timeoutMs}ms`);
    }

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
        const batch = changes.newEvents ?? [];
        events.push(...batch);
        nextFromIndex += batch.length;
      }
    }

    const { status } = await client.sessions.getSessionStatus({ id });
    if (isTerminalSessionStatus(status)) {
      const changes = await finalChanges(client, id, lastChanges, limit);
      return { id, status, events, nextFromIndex, finalChanges: changes, answer: changes?.answer };
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

export async function runSession(
  client: HaiAgentsClient,
  options: RunSessionOptions,
): Promise<SessionRunResult> {
  const { waitForSeconds, includeEvents, timeoutMs, pollBackoffMs, maxPolls, ...createParams } = options;
  assertRequestUnderLimit(createParams);
  const session = await client.sessions.createSession(toCreateRequest(createParams));
  return waitForSession(client, {
    id: session.id,
    waitForSeconds,
    includeEvents,
    timeoutMs,
    pollBackoffMs,
    maxPolls,
  });
}

/** A created session bound to its client: object-oriented sugar over the polling helpers. */
export class SessionHandle {
  constructor(
    private readonly client: HaiAgentsClient,
    public readonly id: string,
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
  waitForCompletion(options?: Omit<WaitForSessionOptions, "id">): Promise<SessionRunResult> {
    return waitForSession(this.client, { id: this.id, ...options });
  }
}
