/** Typed structured output: schema injection and answer parse-back. The zod guard waits for the platform's client sync: pending/answer_schema_overlay.test.ts. */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnswerValidationError, SessionHandle, runSession, tool, waitForSession } from "hai-agents";
// Internal in the TS SDK (Python exports it as a private helper from hai_agents.polling).
import { attachAnswerSchema } from "hai-agents-src/client/polling";

import { raisesAsync } from "./helpers";

// `salary` arrives as a string on the wire and is a number once the schema has run on the answer
// (Python asserts `isinstance(result.answer, JobListings)`; a zod output is a plain object).
const JobListing = z.object({ title: z.string(), company: z.string(), salary: z.coerce.number() }).meta({ id: "JobListing" });

const JobListings = z.object({ jobs: z.array(JobListing) }).meta({ title: "JobListings" });

const _VALID_ANSWER = { jobs: [{ title: "RE", company: "H", salary: "120000" }, { title: "SWE", company: "H", salary: "150000" }] };

class _Status {
  status: string;
  outcome: string | null = null;
  error: string | null = null;
  errorCode: string | null = null;

  constructor(status: string) {
    this.status = status;
  }
}

class _Changes {
  answer: unknown;
  newEvents: unknown[] = [];

  constructor(answer: unknown) {
    this.answer = answer;
  }
}

class _Sessions {
  private answer: unknown;
  private status: string;
  createdWith: Record<string, any> | null = null;

  constructor(answer: unknown, status = "completed") {
    this.answer = answer;
    this.status = status;
  }

  createSession(request: { idempotencyKey?: string | null; body: Record<string, unknown> }) {
    this.createdWith = request.body;
    return { id: "sess_1" };
  }

  getSessionStatus(_request: { id: string }): _Status {
    return new _Status(this.status);
  }

  getSessionChanges(_request: object): _Changes {
    return new _Changes(this.answer);
  }
}

class _Client {
  sessions: _Sessions;

  constructor(answer: unknown, status = "completed") {
    this.sessions = new _Sessions(answer, status);
  }
}

describe("SchemaInjection", () => {
  it("inline dict agent gets answer format", async () => {
    const params: Record<string, any> = await attachAnswerSchema({ agent: { name: "a" } } as never, JobListings);
    const schema = params.agent.answerFormat;
    expect(schema.title).toBe("JobListings");
    expect(schema.$defs).toHaveProperty("JobListing");
  });

  it("catalog agent injected via overrides", async () => {
    const params: Record<string, any> = await attachAnswerSchema({ agent: "h/web-surfer-pro" }, JobListings);
    expect(params.overrides["agent.answer_format"].title).toBe("JobListings");
  });

  it("existing answer format conflicts", async () => {
    await raisesAsync(() => attachAnswerSchema({ agent: { answerFormat: { type: "object" } } } as never, JobListings), Error, /conflicts/);
    await raisesAsync(
      () => attachAnswerSchema({ agent: "h/web-surfer-pro", overrides: { "agent.answer_format": {} } }, JobListings),
      Error,
      /conflicts/,
    );
  });

  it("inline agent with answer format override conflicts", async () => {
    await raisesAsync(
      () => attachAnswerSchema({ agent: { name: "a" }, overrides: { "agent.answer_format": {} } } as never, JobListings),
      Error,
      /conflicts/,
    );
  });

  it("user overrides preserved", async () => {
    const params: Record<string, any> = await attachAnswerSchema(
      { agent: "h/web-surfer-pro", overrides: { "agent.max_steps": 5 } },
      JobListings,
    );
    expect(params.overrides["agent.max_steps"]).toBe(5);
  });
});

describe("AnswerParseBack", () => {
  it("completed answer validates into model", async () => {
    const client = new _Client(_VALID_ANSWER);
    const result = await runSession(client as never, { agent: "h/web-surfer-pro", messages: "find jobs", answerSchema: JobListings });
    expect(typeof result.answer?.jobs[0].salary).toBe("number");
    expect(result.answer?.jobs[1].title).toBe("SWE");
    expect(client.sessions.createdWith!.overrides["agent.answer_format"].title).toBe("JobListings");
    expect(result.finalChanges!.answer).toEqual(_VALID_ANSWER);
  });

  it("json string answer parses into model", async () => {
    const client = new _Client(JSON.stringify(_VALID_ANSWER));
    const result = await waitForSession(client as never, { id: "sess_1", answerSchema: JobListings });
    expect(typeof result.answer?.jobs[0].salary).toBe("number");
    expect(result.answer?.jobs[0].title).toBe("RE");
  });

  it("non json string answer raises", async () => {
    const client = new _Client("plain text answer");
    const error = await raisesAsync(
      () => waitForSession(client as never, { id: "sess_1", answerSchema: JobListings }),
      AnswerValidationError,
    );
    expect(error.raw).toBe("plain text answer");
  });

  it("nonconforming answer raises with raw", async () => {
    const client = new _Client({ jobs: "not-a-list" });
    const error = await raisesAsync(
      () => waitForSession(client as never, { id: "sess_1", answerSchema: JobListings }),
      AnswerValidationError,
    );
    expect(error.raw).toEqual({ jobs: "not-a-list" });
  });

  it("non completed status passes raw through", async () => {
    const client = new _Client("cancelled mid-run", "interrupted");
    const result = await waitForSession(client as never, { id: "sess_1", answerSchema: JobListings });
    expect(result.answer).toBe("cancelled mid-run");
  });

  it("completed none answer raises", async () => {
    const client = new _Client(null);
    const error = await raisesAsync(
      () => waitForSession(client as never, { id: "sess_1", answerSchema: JobListings }),
      AnswerValidationError,
    );
    expect(error.raw).toBeNull();
  });

  it("non completed none answer passes through", async () => {
    const client = new _Client(null, "failed");
    const result = await waitForSession(client as never, { id: "sess_1", answerSchema: JobListings });
    expect(result.answer).toBeNull();
  });

  it("no schema keeps raw answer", async () => {
    const client = new _Client(_VALID_ANSWER);
    const result = await waitForSession(client as never, { id: "sess_1" });
    expect(result.answer).toEqual(_VALID_ANSWER);
  });
});

describe("ComposesWithTools", () => {
  it("schema and tools attach independent overrides", async () => {
    const get_weather = tool({
      name: "get_weather",
      description: "Get the weather.",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      fn: (_args) => "sunny",
    });

    const client = new _Client(_VALID_ANSWER);
    const result = await runSession(client as never, {
      agent: "h/web-surfer-pro",
      messages: "go",
      answerSchema: JobListings,
      tools: [get_weather],
    });
    const overrides = client.sessions.createdWith!.overrides;
    expect(overrides["agent.answer_format"].title).toBe("JobListings");
    expect(overrides["agent.tools"][0].name).toBe("get_weather");
    expect(typeof result.answer?.jobs[0].salary).toBe("number");
  });
});

describe("SessionHandle", () => {
  it("handle carries schema into wait for completion", async () => {
    const client = new _Client(_VALID_ANSWER);
    const handle = new SessionHandle(client as never, "sess_1", JobListings);
    const result = await handle.waitForCompletion();
    expect(typeof result.answer?.jobs[0].salary).toBe("number");
  });

  it("explicit none disables handle schema", async () => {
    const client = new _Client(_VALID_ANSWER);
    const handle = new SessionHandle(client as never, "sess_1", JobListings);
    const result = await handle.waitForCompletion({ answerSchema: undefined });
    expect(result.answer).toEqual(_VALID_ANSWER); // the raw dict: `salary` still a string
  });
});
