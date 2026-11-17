// The generated resource clients and HttpResponsePromise that sessions.ts subclasses and builds, as
// the main entry exports them (this entry imports the client through it only: scripts/link-local-entry.mjs),
// and the types sessions.ts reads off them.
import type { SessionsClient } from "../client/index.js";

export { AgentsClient, EnvironmentsClient, HttpResponsePromise, SessionsClient } from "../client/index.js";
export type ClientOptions = SessionsClient.Options;
export type Sessions = SessionsClient;
export type RequestOptions = SessionsClient.RequestOptions;
/** What `.withRawResponse()` of a resource method's promise resolves to. */
export type WithRaw<P> = P extends { withRawResponse(): Promise<infer R> } ? R : never;
