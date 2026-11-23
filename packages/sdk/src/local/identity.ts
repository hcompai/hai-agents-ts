/**
 * Runtime identity. Any local process can bind a loopback port, so the client authenticates the
 * server too: every request carries a fresh challenge, and the runtime answers it with
 * HMAC-SHA256(token, challenge). A response without the right proof is rejected.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Agent, fetch as undiciFetch } from "undici";

import { LocalRuntimeError } from "./errors.js";

export const CHALLENGE_HEADER = "X-Hai-Runtime-Challenge";
export const PROOF_HEADER = "X-Hai-Runtime-Proof";

/** The proof a runtime holding `token` returns for `challenge`. */
export function runtimeProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(challenge).digest("hex");
}

/**
 * Python's `trust_env=False`: a loopback request never goes through the proxy the environment names
 * (Node's fetch would, with NODE_USE_ENV_PROXY set), so it gets undici's plain agent as its dispatcher.
 */
export const LOOPBACK_DISPATCHER = new Agent();

/**
 * Throw unless `response` proves its server holds `token` for the `challenge` the request sent. A redirect is a
 * failed proof too: the runtime never redirects, and following one would carry the bearer token elsewhere.
 */
export function verifyProof(token: string, url: string, challenge: string, response: Response): void {
  const expected = Buffer.from(runtimeProof(token, challenge));
  const received = Buffer.from(response.headers.get(PROOF_HEADER) ?? "");
  const redirected = response.status >= 300 && response.status < 400;
  if (redirected || !challenge || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new LocalRuntimeError(
      `${new URL(url).origin} did not prove it is the runtime this client started or attached to: ` +
        "another process holds the port, or the runtime predates identity proofs",
    );
  }
}

/**
 * A `fetch` that challenges every request and rejects any response the runtime holding `token` did not prove.
 * Redirects are not followed (httpx does not either): a 3xx fails the proof before anything is re-sent.
 */
export function provenFetch(token: string): typeof fetch {
  return async (input, init) => {
    const challenge = randomBytes(24).toString("base64url");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(CHALLENGE_HEADER, challenge);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // undici's own fetch takes the dispatcher; its Response is the same WHATWG shape the client reads.
    const response = (await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      headers,
      redirect: "manual",
      dispatcher: LOOPBACK_DISPATCHER,
    })) as unknown as Response;
    verifyProof(token, url, challenge, response);
    return response;
  };
}
