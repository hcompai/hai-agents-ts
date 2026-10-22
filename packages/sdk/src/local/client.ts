import type * as HaiAgents from "../client/api/index.js";
import { SessionsClient } from "../client/api/resources/sessions/client/Client.js";
import * as core from "../client/core/index.js";
import { HaiAgentsClient as HostedClient } from "../client/oo.js";
import { LocalRuntimeError, provenFetch } from "./identity.js";
import { LocalRuntime, type LocalRuntimeOptions, type RuntimeHandle } from "./runtime.js";

// Statuses whose state a runtime shutdown would destroy ("idle" awaits input but keeps state).
const ACTIVE: HaiAgents.TrajectoryStatus[] = ["queued", "pending", "running", "paused", "idle", "awaiting_tool_results"];

export interface LocalOptions extends LocalRuntimeOptions {
  /** Client options other than where and how to reach the runtime. */
  client?: Omit<HostedClient.Options, "baseUrl" | "environment" | "apiKey" | "auth">;
}

/** Sessions that remember which ids this client created. */
class TrackedSessionsClient extends SessionsClient {
  readonly created = new Set<string>();

  override createSession(
    request: HaiAgents.CreateSessionRequest,
    requestOptions?: SessionsClient.RequestOptions,
  ): core.HttpResponsePromise<HaiAgents.Session> {
    rejectUserDevice(request.body.agent);
    return core.HttpResponsePromise.fromPromise(
      super
        .createSession(request, requestOptions)
        .withRawResponse()
        .then((created) => {
          this.created.add(created.data.id);
          return created;
        }),
    );
  }
}

function rejectUserDevice(agent: HaiAgents.SessionRequestAgent): void {
  if (typeof agent === "string") return;
  for (const env of agent.environments ?? []) {
    if (typeof env !== "string" && "host" in env && env.host === "user_device") {
      throw new LocalRuntimeError(`environment ${env.id ?? env.kind} has host "user_device", which needs a local bridge`);
    }
  }
  for (const sub of agent.subagents ?? []) rejectUserDevice(sub);
}

/** The SDK client, able to run agents on this machine through a local `hai-agent-runtime`. */
export class HaiAgentsClient extends HostedClient {
  #runtime: LocalRuntime | undefined;

  /** A client for a local runtime: attaches to the one serving this inference, or starts it. */
  static async local(options: LocalOptions = {}): Promise<HaiAgentsClient> {
    const { client: clientOptions, ...runtimeOptions } = options;
    const runtime = await LocalRuntime.start(runtimeOptions);
    const { url, token } = runtime.handle;
    const client = new HaiAgentsClient({
      ...clientOptions,
      baseUrl: url,
      apiKey: token,
      fetch: provenFetch(token, clientOptions?.fetch),
    });
    client.#runtime = runtime;
    return client;
  }

  /** The local runtime this client talks to; undefined for the hosted API. */
  get runtime(): RuntimeHandle | undefined {
    return this.#runtime?.handle;
  }

  override get sessions(): TrackedSessionsClient {
    return (this._sessions ??= new TrackedSessionsClient(this._options)) as TrackedSessionsClient;
  }

  /** Stop the runtime this client started, unless another client's session is still active on it. */
  async close(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime?.owned || (await this.#hostsForeignSession())) return;
    await runtime.stop();
  }

  async #hostsForeignSession(): Promise<boolean> {
    const ours = this.sessions.created;
    for (let page = 1; ; page++) {
      const listed = await this.sessions.listSessions({ status: ACTIVE, page, size: 50 });
      if (listed.items.some((item) => !ours.has(item.id))) return true;
      if (listed.items.length === 0 || page * 50 >= listed.total) return false;
    }
  }
}
