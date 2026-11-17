/**
 * Where the local runtime sends its model calls: H's hosted inference (the default) or an
 * endpoint you host. Independent of where environments run.
 */

export const URL_ENV = "HAI_AGENT_RUNTIME_BASE_URL";
export const MODEL_ENV = "HAI_AGENT_RUNTIME_MODEL";
// Python defines it in client.py, platform-owned here.
export const API_KEY_VAR = "HAI_API_KEY";
export const HOSTED = "hosted";

export type Env = Record<string, string | undefined>;

export class Inference {
  private constructor(
    public readonly baseUrl?: string,
    public readonly model?: string,
  ) {}

  /** H's hosted models; the runtime authenticates with the H API key. */
  static cloud(): Inference {
    return new Inference();
  }

  /** A model server you host. The H API key is never forwarded to it. */
  static selfHosted(baseUrl: string, model: string): Inference {
    let parsed: URL | undefined;
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = undefined;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || !model) {
      throw new Error("self-hosted inference requires an HTTP(S) endpoint and model");
    }
    return new Inference(baseUrl, model);
  }

  /** The server `HAI_AGENT_RUNTIME_BASE_URL` selects in `env`, else undefined. */
  static fromEnv(env: Env): Inference | undefined {
    const url = (env[URL_ENV] ?? "").trim();
    return url ? new Inference(url, (env[MODEL_ENV] ?? "").trim() || undefined) : undefined;
  }

  /** `env` adjusted for a runtime process that infers here. */
  runtimeEnv(env: Env): Env {
    const out: Env = { ...env };
    if (this.baseUrl !== undefined) {
      // Never hand the hosted credential to a user-chosen endpoint.
      delete out[API_KEY_VAR];
      out[URL_ENV] = this.baseUrl;
    } else {
      delete out[URL_ENV];
    }
    if (this.model !== undefined) {
      out[MODEL_ENV] = this.model;
    }
    return out;
  }
}

/**
 * What a runtime started with `env` infers against: "hosted", or "<url> <model>".
 * A spawner records it next to the runtime so that attachers never borrow a runtime of another inference.
 */
export function servedInference(env: Env): string {
  const url = (env[URL_ENV] ?? "").trim();
  const model = (env[MODEL_ENV] ?? "").trim();
  return [url || HOSTED, model].filter(Boolean).join(" ");
}
