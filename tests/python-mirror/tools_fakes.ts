/** test_tools.py's module-level fakes, shared by tools.test.ts and pending/tools_overlay.test.ts. */
import { tool } from "hai-agents";

export const get_weather = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", default: "celsius" } }, required: ["city"] },
  fn: ({ city, unit = "celsius" }) => `Sunny in ${city} (${unit})`,
});

export interface RecordedRequest {
  path: string;
  method: string;
  json: unknown;
  request_options: unknown;
}

/** The client's passthrough `fetch`, recording every tool-result post and answering from a status queue. */
export class _FakeHttpx {
  requests: RecordedRequest[] = [];
  private statuses: number[];

  constructor(statuses?: number[]) {
    this.statuses = [...(statuses ?? [])];
  }

  fetch = async (input: string | URL | Request, init?: RequestInit, requestOptions?: unknown): Promise<Response> => {
    this.requests.push({
      path: String(input),
      method: init?.method ?? "GET",
      json: init?.body ? JSON.parse(String(init.body)) : null,
      request_options: requestOptions,
    });
    const status = this.statuses.length ? this.statuses.shift()! : 202;
    return new Response("", { status });
  };
}

type Poll = [unknown, string];

export class _FakeSessions {
  private polls: Poll[];
  createdWith: Record<string, any> | null = null;

  constructor(polls: Poll[]) {
    this.polls = [...polls];
  }

  createSession(request: { idempotencyKey?: string | null; body: Record<string, unknown> }) {
    this.createdWith = request.body;
    return { id: "sess_1" };
  }

  getSessionChanges(_request: object) {
    return this.polls.length ? this.polls[0][0] : null;
  }

  getSessionStatus(_request: object) {
    const [, status] = this.polls.shift()!;
    return { status, outcome: null, error: null, errorCode: null };
  }
}

/** A pending tool call exactly as the serde layer hands it to the loop: a ToolRequest of {toolName, args, id}. */
export function _pending(id: string, toolName: string, args: Record<string, unknown> | null = null) {
  return { id, toolName, args: args ?? {} };
}

export function _awaitingChanges(...calls: ReturnType<typeof _pending>[]) {
  const event = {
    type: "ActiveStateChangeEvent",
    data: { state: "awaiting_tool_results", pendingToolCalls: [...calls] },
  };
  return { newEvents: [event], answer: null };
}

export const clientWith = (sessions: unknown, httpx: _FakeHttpx) => ({ sessions, fetch: httpx.fetch }) as never;
