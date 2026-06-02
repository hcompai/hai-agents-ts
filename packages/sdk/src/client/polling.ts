import { createSession, getSessionChanges, type Options } from "./sdk.gen";
import type {
  CreateSessionData,
  GetSessionChangesData,
  SessionRequest,
  TrajectoryChanges,
  TrajectoryEvent,
  TrajectoryStatus,
} from "./types.gen";

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

export type WaitForSessionOptions = Omit<
  Options<GetSessionChangesData, true>,
  "path" | "query"
> & {
  id: string;
  fromIndex?: number;
  waitForSeconds?: number;
  limit?: number | null;
  maxPolls?: number;
};

export type RunSessionUntilDoneOptions = Omit<
  Options<CreateSessionData, true>,
  "body"
> & {
  body: SessionRequest;
  waitForSeconds?: number;
  maxPolls?: number;
};

export const isTerminalSessionStatus = (status: TrajectoryStatus): boolean =>
  (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);

export async function waitForSession(
  options: WaitForSessionOptions,
): Promise<SessionRunResult> {
  const {
    id,
    fromIndex = 0,
    waitForSeconds = 20,
    limit,
    maxPolls,
    ...requestOptions
  } = options;
  const events: TrajectoryEvent[] = [];
  let nextFromIndex = fromIndex;

  for (let polls = 0; maxPolls === undefined || polls < maxPolls; polls += 1) {
    const { data, response } = await getSessionChanges({
      ...requestOptions,
      throwOnError: true,
      path: { id },
      query: {
        from_index: nextFromIndex,
        include_events: true,
        limit,
        wait_for_seconds: waitForSeconds,
      },
    });

    if (response.status === 204 || !data) {
      continue;
    }

    const batch = data.new_events ?? [];
    for (const event of batch) {
      events.push(event);
    }
    nextFromIndex += batch.length;

    if (isTerminalSessionStatus(data.status)) {
      return {
        id,
        finalChanges: data,
        events,
        nextFromIndex,
      };
    }
  }

  throw new Error(`Session ${id} did not reach a terminal status before maxPolls=${maxPolls}`);
}

export async function runSessionUntilDone(
  options: RunSessionUntilDoneOptions,
): Promise<SessionRunResult> {
  const { body, waitForSeconds, maxPolls, ...requestOptions } = options;
  const { data: session } = await createSession({
    ...requestOptions,
    throwOnError: true,
    body,
  });

  return waitForSession({
    ...requestOptions,
    id: session.id,
    waitForSeconds,
    maxPolls,
  });
}
