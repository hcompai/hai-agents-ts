import type { HaiAgentsClient } from "./Client.js";
import type {
  CreateSessionRequest,
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

export type SessionRunResult = {
  id: string;
  finalChanges: TrajectoryChanges;
  events: TrajectoryEvent[];
  nextFromIndex: number;
};

export type WaitForSessionOptions = {
  id: string;
  fromIndex?: number;
  waitForSeconds?: number;
  limit?: number | null;
  maxPolls?: number;
};

export type RunSessionUntilDoneOptions = CreateSessionRequest & {
  waitForSeconds?: number;
  maxPolls?: number;
};

export const isTerminalSessionStatus = (status: TrajectoryStatus): boolean =>
  (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);

export async function waitForSession(
  client: HaiAgentsClient,
  options: WaitForSessionOptions,
): Promise<SessionRunResult> {
  const { id, fromIndex = 0, waitForSeconds = 20, limit, maxPolls } = options;
  const events: TrajectoryEvent[] = [];
  let nextFromIndex = fromIndex;

  for (let polls = 0; maxPolls === undefined || polls < maxPolls; polls += 1) {
    const changes = await client.sessions.getSessionChanges({
      id,
      from_index: nextFromIndex,
      include_events: true,
      limit: limit ?? undefined,
      wait_for_seconds: waitForSeconds,
    });

    if (!changes) {
      continue;
    }

    const batch = changes.new_events ?? [];
    events.push(...batch);
    nextFromIndex += batch.length;

    if (isTerminalSessionStatus(changes.status)) {
      return { id, finalChanges: changes, events, nextFromIndex };
    }
  }

  throw new Error(`Session ${id} did not reach a terminal status before maxPolls=${maxPolls}`);
}

export async function runSessionUntilDone(
  client: HaiAgentsClient,
  options: RunSessionUntilDoneOptions,
): Promise<SessionRunResult> {
  const { waitForSeconds, maxPolls, ...createRequest } = options;
  const session = await client.sessions.createSession(createRequest);
  return waitForSession(client, { id: session.id, waitForSeconds, maxPolls });
}
