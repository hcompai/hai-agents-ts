<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/hcompai/hai-agents-ts/blob/main/assets/banner-dark.gif?raw=true" />
    <img src="https://github.com/hcompai/hai-agents-ts/blob/main/assets/banner-light.gif?raw=true" alt="H Agent API" width="700" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/npm/v/hai-agents.svg" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/node/v/hai-agents.svg" alt="Node version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  TypeScript SDK for the <a href="https://hcompany.ai">H Company</a> <a href="https://hub.hcompany.ai/agent-api">Agent API</a>. Launch autonomous agents powered by Holo, stream their progress, and steer them mid-run.
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

Requires Node.js 18 or newer. Grab an API key at [portal.hcompany.ai](https://portal.hcompany.ai) and export it:

```bash
export H_API_KEY=hk-...
```

## Quickstart

Launch the built-in `h/web-surfer-holo3-1-35b` agent, which ships with its own browser, and describe the task in plain language. `runSession` polls until the agent finishes and returns the final answer.

```ts
import { HaiAgentsClient, runSession } from "hai-agents";

const client = new HaiAgentsClient(); // reads H_API_KEY from the environment

const result = await runSession(client, {
  agent: "h/web-surfer-holo3-1-35b",
  messages: "What are the top 3 stories on Hacker News right now?",
});

console.log(result.status); // "completed"
console.log(result.answer);
```

## Structured output

Pass a [Zod v4](https://zod.dev) schema as `answerSchema` and the agent's final answer resolves as a parsed, typed value. The schema is sent as the agent's answer format; the raw wire value stays at `result.finalChanges.answer`. Zod is an optional peer dependency, only needed when you use this.

```ts
import { HaiAgentsClient, runSession } from "hai-agents";
import { z } from "zod";

const Jobs = z.object({
  jobs: z.array(z.object({ title: z.string(), company: z.string() })),
});

const client = new HaiAgentsClient();
const result = await runSession(client, {
  agent: "h/web-surfer-holo3-1-35b",
  messages: "Find 3 open ML engineering roles in Paris.",
  answerSchema: Jobs,
});

for (const job of result.answer?.jobs ?? []) {
  console.log(job.title, "@", job.company); // typed via z.infer
}
```

A completed answer that does not match the schema throws `AnswerValidationError` (raw payload on `.raw`). Sessions that end without completing (cancelled, timed out) resolve with their raw answer untouched.

## Custom tools

Give the agent tools that run in your own process. Declare each tool with a JSON schema and a function; the SDK registers them on the session, executes them when the agent calls them, and posts the results back so the agent can continue.

```ts
import { HaiAgentsClient, runSession, tool } from "hai-agents";

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

const result = await runSession(client, {
  agent: "h/web-surfer-holo3-1-35b",
  messages: "What should I wear in Paris today?",
  tools: [getWeather],
});

console.log(result.answer);
```

Tool functions may be sync or async. Exceptions are reported back to the agent as tool errors instead of crashing the run.

## Documentation

Guides, core concepts, and the full API reference live at **[hub.hcompany.ai/agent-api](https://hub.hcompany.ai/agent-api)**, covering streaming progress, steering a live session, regions, structured output, and error handling.

## License

[MIT](LICENSE)
