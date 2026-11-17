/**
 * Runtime identity. Any local process can bind a loopback port, so the client authenticates the
 * server too: every request carries a fresh challenge, and the runtime answers it with
 * HMAC-SHA256(token, challenge). A response without the right proof is rejected.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { LocalRuntimeError } from "./errors.js";

export const CHALLENGE_HEADER = "X-Hai-Runtime-Challenge";
export const PROOF_HEADER = "X-Hai-Runtime-Proof";

/** The proof a runtime holding `token` returns for `challenge`. */
export function runtimeProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(challenge).digest("hex");
}

/** Throw unless `response` proves its server holds `token` for the `challenge` the request sent. */
export function verifyProof(token: string, url: string, challenge: string, response: Response): void {
  const expected = Buffer.from(runtimeProof(token, challenge));
  const received = Buffer.from(response.headers.get(PROOF_HEADER) ?? "");
  if (!challenge || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new LocalRuntimeError(
      `${new URL(url).origin} did not prove it is the runtime this client started or attached to: ` +
        "another process holds the port, or the runtime predates identity proofs",
    );
  }
}

/** A `fetch` that challenges every request and rejects any response the runtime holding `token` did not prove. */
export function provenFetch(token: string): typeof fetch {
  return async (input, init) => {
    const challenge = randomBytes(24).toString("base64url");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(CHALLENGE_HEADER, challenge);
    const response = await fetch(input, { ...init, headers });
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    verifyProof(token, url, challenge, response);
    return response;
  };
}
