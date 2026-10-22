import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CHALLENGE_HEADER = "X-Hai-Runtime-Challenge";
export const PROOF_HEADER = "X-Hai-Runtime-Proof";

/** A local runtime failed to install, start, attach, or prove its identity. */
export class LocalRuntimeError extends Error {
  override name = "LocalRuntimeError";
}

/** A fetch that rejects any response not proven by the runtime holding `token`, so a port squatter is caught. */
export function provenFetch(token: string, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const challenge = randomBytes(24).toString("base64url");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(CHALLENGE_HEADER, challenge);
    const response = await base(input, { ...init, headers });
    const expected = Buffer.from(createHmac("sha256", token).update(challenge).digest("hex"));
    const proof = Buffer.from(response.headers.get(PROOF_HEADER) ?? "");
    if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
      throw new LocalRuntimeError(
        `${new URL(response.url || String(input)).origin} did not prove it is the local runtime this client attached to`,
      );
    }
    return response;
  };
}
