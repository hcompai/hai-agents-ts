import { HaiAgentsClient as FernClient } from "./Client.js";
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
import type { TrajectoryChanges } from "./api/index.js";
import { asTools, type Tool } from "./tools.js";

/**
 * The public SDK client. Extends the Fern-generated client with create-and-run
 * convenience methods (`runSession`, `startSession`, `session`) that delegate to
 * the hand-written polling helpers.
 */
export class HaiAgentsClient extends FernClient {
  /** Create a session and resolve once it completes, returning the result and final answer. */
  public runSession<TAnswer = TrajectoryChanges["answer"]>(
    options: RunSessionOptions<TAnswer>,
  ): Promise<SessionRunResult<TAnswer>> {
    return runSession(this, options);
  }

  /** Create a session and return a handle to it without waiting. */
  public async startSession<TAnswer = TrajectoryChanges["answer"]>(
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

export namespace HaiAgentsClient {
  export type Options = FernClient.Options;
  export type RequestOptions = FernClient.RequestOptions;
}
