import { HaiAgentsClient as FernClient } from "./Client.js";
import {
  SessionHandle,
  assertRequestUnderLimit,
  attachToolDefinitions,
  runSession,
  toCreateRequest,
  type CreateSessionParams,
  type RunSessionOptions,
  type SessionRunResult,
} from "./polling.js";
import { asTools, type Tool } from "./tools.js";

/**
 * The public SDK client. Extends the Fern-generated client with create-and-run
 * convenience methods (`runSession`, `startSession`, `session`) that delegate to
 * the hand-written polling helpers.
 */
export class HaiAgentsClient extends FernClient {
  /** Create a session and resolve once it completes, returning the result and final answer. */
  public runSession(options: RunSessionOptions): Promise<SessionRunResult> {
    return runSession(this, options);
  }

  /** Create a session and return a handle to it without waiting. */
  public async startSession(params: CreateSessionParams & { tools?: readonly Tool[] }): Promise<SessionHandle> {
    const { tools, ...createParams } = params;
    const normalizedTools = asTools(tools ?? []);
    const withTools =
      normalizedTools.length > 0 ? attachToolDefinitions(createParams, normalizedTools) : createParams;
    assertRequestUnderLimit(withTools);
    const session = await this.sessions.createSession(toCreateRequest(withTools));
    return new SessionHandle(this, session.id, normalizedTools.length > 0 ? normalizedTools : undefined);
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
