<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/hcompai/hai-agents-ts/blob/main/assets/banner-dark.gif?raw=true" />
    <img src="https://github.com/hcompai/hai-agents-ts/blob/main/assets/banner-light.gif?raw=true" alt="Computer-Use Agents" width="700" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/npm/v/hai-agents.svg" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/node/v/hai-agents.svg" alt="Node version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  TypeScript SDK for <a href="https://hcompany.ai">H Company</a>'s <a href="https://hub.hcompany.ai/agent-api">Computer-Use Agents</a>.
</p>

<p align="center">
  <b><a href="https://hub.hcompany.ai/agent-api">Documentation</a></b>
  &nbsp;·&nbsp;
  <a href="https://portal.hcompany.ai">Get an API key</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/hai-agents">npm</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/hcompai/hai-agents-python">Python SDK</a>
  &nbsp;·&nbsp;
  <a href="https://hcompany.ai">H Company</a>
</p>

## Installation

```bash
npm install hai-agents
```

Node.js 18 or newer is required. Get an API key at [portal.hcompany.ai](https://portal.hcompany.ai) and export it:

```bash
export HAI_API_KEY=hk-...
```

## Quickstart

Launch the built-in `h/web-surfer-holo3-1-35b` agent, which ships with its own browser, and describe the task in plain language. `runSession` polls until the agent finishes and returns the final answer.

```ts
import { HaiAgentsClient } from "hai-agents";

const client = new HaiAgentsClient(); // reads HAI_API_KEY from the environment

const result = await client.runSession({
  agent: "h/web-surfer-holo3-1-35b",
  messages: "What are the top 3 stories on Hacker News right now?",
});

console.log(result.status); // "completed"
console.log(result.answer);
```

`result` is a `SessionRunResult`: `id`, `status`, `answer`, the accumulated `events`, and `finalChanges`.

## How a session works

A session is one run of an agent against a task. It moves through a small set of states: `pending`, `running`, and then a settled state such as `completed`, `idle`, `failed`, `timed_out`, or `interrupted`.

You drive a session two ways. `runSession` creates it and resolves once it settles, which suits one-shot tasks. `startSession` creates it and returns a handle right away, so you can read and steer the agent while it works.

```ts
const session = await client.startSession({
  agent: "h/web-surfer-holo3-1-35b",
  messages: "Find the top story on Hacker News",
});

console.log(session.id);
const result = await session.waitForCompletion();
console.log(result.status, result.answer);
```

## Watch and steer a running session

A handle bound to the session `id` exposes the full lifecycle. Read the agent's progress at three levels of detail:

```ts
await session.status();                  // cheap snapshot: state, step count, token usage
await session.changes({ fromIndex: 0 }); // new events and the final answer, long-polled
await session.get();                     // the full Session resource
```

While the session is not in a terminal state, you can intervene:

```ts
await session.sendMessage({ type: "user_message", message: "Only consider the last 24 hours" });
await session.pause();       // halt with state preserved
await session.resume();      // continue where it left off
await session.forceAnswer(); // stop exploring and answer from what it has
await session.cancel();      // stop for good; ends in "interrupted"
```

`sendMessage` redirects the agent on its next step. Sending a message to an `idle` session also wakes it.

## Multi-turn sessions

By default a session ends as soon as the agent answers. Set `idleTimeoutS` to keep it open: after each answer the session goes `idle` and waits that long for your next message, carrying its full context and browser state across turns.

```ts
const session = await client.startSession({
  agent: "h/web-surfer-holo3-1-35b",
  idleTimeoutS: 600,
  messages: "Find the top story on Hacker News",
});
const first = await session.waitForCompletion();

await session.sendMessage({ type: "user_message", message: "Now summarize its comments" });
const second = await session.waitForCompletion();
```

## Structured output

Pass a [Zod v4](https://zod.dev) schema as `answerSchema` and the agent's final answer resolves as a parsed, typed value. The schema is sent as the agent's answer format; the raw wire value stays at `result.finalChanges.answer`. Zod is an optional peer dependency, only needed when you use this.

```ts
import { HaiAgentsClient } from "hai-agents";
import { z } from "zod";

const Jobs = z.object({
  jobs: z.array(z.object({ title: z.string(), company: z.string() })),
});

const client = new HaiAgentsClient();
const result = await client.runSession({
  agent: "h/web-surfer-holo3-1-35b",
  messages: "Find 3 open ML engineering roles in Paris.",
  answerSchema: Jobs,
});

for (const job of result.answer?.jobs ?? []) {
  console.log(job.title, "@", job.company); // typed via z.infer
}
```

A completed answer that does not match the schema throws `AnswerValidationError`, with the raw payload on `.raw`. Sessions that end without completing resolve with their raw answer untouched.

## Custom tools

Give the agent tools that run in your own process. Declare each tool with a JSON schema and a function; the SDK registers them on the session, runs them when the agent calls them, and posts the results back so the agent can continue.

```ts
import { HaiAgentsClient, tool } from "hai-agents";

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  fn: async ({ city }) => `Sunny in ${city}, 24C`,
});

const client = new HaiAgentsClient();

const result = await client.runSession({
  agent: "h/web-surfer-holo3-1-35b",
  messages: "What should I wear in Paris today?",
  tools: [getWeather],
});

console.log(result.answer);
```

Tool functions may be sync or async. A tool that throws is reported to the agent as a tool error rather than crashing the run.

## Browser profiles and vaults

Start a session on a browser that already knows the user. A [browser profile](https://hub.hcompany.ai/agent-api) restores saved cookies and storage from an earlier session, and a [vault](https://hub.hcompany.ai/agent-api) lets the agent sign in to sites with secrets that never enter its context. Bind both through per-run overrides:

```ts
const result = await client.runSession({
  agent: "h/web-surfer-holo3-1-35b",
  messages: "Open my dashboard and report any new alerts",
  overrides: {
    "agent.environments[kind=web].browser_profile_id": "<profile-id>",
    "agent.environments[kind=web].vault_id": "<vault-id>",
  },
});
```

## Inspect and share sessions

List past sessions and create a public replay link:

```ts
const page = await client.sessions.listSessions({ size: 10 });
for (const summary of page.items) {
  console.log(summary.id, summary.status);
}

const link = await client.sessions.shareSession({ id: "<session-id>" });
console.log(link.shareUrl);
```

## Regions and configuration

The client targets the EU region by default. Point it at the US region or a custom URL, and pass the API key in code when you do not want to use the environment variable:

```ts
import { HaiAgentsClient, HaiAgentsEnvironment } from "hai-agents";

const client = new HaiAgentsClient({ environment: HaiAgentsEnvironment.Us });
// or
const client = new HaiAgentsClient({ baseUrl: "https://agp.hcompany.ai", apiKey: "hk-..." });
```

## Errors

```ts
import { HaiAgentsError, HaiAgentsTimeoutError, AnswerValidationError } from "hai-agents";
```

`HaiAgentsError` is the base for HTTP failures and carries `.statusCode` and `.body`. `HaiAgentsTimeoutError` is thrown when a request exceeds its time budget. `HaiAgents.UnprocessableEntityError` is the 422 raised when a request fails validation. `AnswerValidationError` is thrown when a completed answer does not match `answerSchema`, with the unparsed value on `.raw`.

## Webhooks

Verify the signature on an incoming webhook before trusting it:

```ts
import { verifyWebhook, WebhookVerificationError } from "hai-agents";

const event = verifyWebhook(rawBody, signature, timestamp, secret);
console.log(event.type, event.data);
```

## Documentation

Guides, core concepts, and the full API reference live at **[hub.hcompany.ai/agent-api](https://hub.hcompany.ai/agent-api)**.

## License

[MIT](LICENSE)
