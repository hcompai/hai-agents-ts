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
  TypeScript SDK for the H Company Agent API. Launch autonomous agents powered by Holo, stream their progress, and steer them mid-run.
</p>

<p align="center">
  <b><a href="https://hub.hcompany.ai/agent-api">Documentation</a></b>
  &nbsp;·&nbsp;
  <a href="https://portal.hcompany.ai">Get an API key</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/hai-agents">npm</a>
  &nbsp;·&nbsp;
  <a href="https://hcompany.ai">H Company</a>
</p>

## Install

```bash
npm install hai-agents
```

Requires Node.js 18 or newer. Grab an API key at [portal.hcompany.ai](https://portal.hcompany.ai).

## Quickstart

Launch the built-in `h/web-surfer-holo3-1-35b` agent, which ships with its own
browser, and describe the task in plain language. `runSessionUntilDone` polls
until the agent reaches a terminal state and returns the final answer.

```ts
import { HaiAgentsClient, runSessionUntilDone } from "hai-agents";

const client = new HaiAgentsClient({ token: process.env.H_API_KEY });

const result = await runSessionUntilDone(client, {
  body: {
    agent: "h/web-surfer-holo3-1-35b",
    messages: "What are the top 3 stories on Hacker News right now?",
  },
});

console.log(result.status); // "completed"
console.log(result.answer);
```

Tune the run with `timeoutMs`, `pollBackoffMs`, and `includeEvents`.

## Create a session and poll it yourself

For finer control, create the session and read it directly. `getSessionStatus`
is a lightweight liveness check; the final `answer` lands in `getSessionChanges`.

```ts
const session = await client.sessions.createSession({
  body: {
    agent: "h/web-surfer-holo3-1-35b",
    messages: "What are the top 3 stories on Hacker News right now?",
  },
});

const status = await client.sessions.getSessionStatus({ id: session.id });
console.log(status.status, status.steps);

const changes = await client.sessions.getSessionChanges({ id: session.id, fromIndex: 0 });
console.log(changes.answer);
```

## Steer a running session

Send a message to redirect the agent mid-run, or record feedback once it finishes.

```ts
await client.sessions.sendSessionMessages({
  id: session.id,
  body: { type: "user_message", message: "Only consider stories posted in the last 24 hours." },
});

await client.sessions.submitSessionFeedback({
  id: session.id,
  body: { success: true, message: "The answer matched the front page." },
});
```

`cancelSession` asks the platform to interrupt the run. The session may still
report `running` briefly while the worker stops; poll until it reaches a terminal
state such as `interrupted`.

```ts
await client.sessions.cancelSession({ id: session.id });
```

## Error handling

Operations reject with `HaiAgentsError` on a non-2xx response. Inspect
`statusCode` and `body`; there is no `{ data, error }` tuple to unwrap.

```ts
import { HaiAgentsError } from "hai-agents";

try {
  const session = await client.sessions.getSession({ id });
  console.log(session.status);
} catch (err) {
  if (err instanceof HaiAgentsError) {
    console.error(err.statusCode, err.message, err.body);
  }
  throw err;
}
```

## Regions

The client targets the EU region by default. Select a region with `environment`,
or point at a custom URL with `baseUrl`.

```ts
import { HaiAgentsClient, HaiAgentsEnvironment } from "hai-agents";

const usClient = new HaiAgentsClient({
  token: process.env.H_API_KEY,
  environment: HaiAgentsEnvironment.Us,
});

const proxied = new HaiAgentsClient({
  token: process.env.H_API_KEY,
  baseUrl: "https://my-proxy.example.com",
});
```

## Request size limit

The platform rejects request bodies above 5MB. `runSessionUntilDone` enforces
this on the create payload; for ad-hoc requests, validate first to fail fast with
a clear message instead of a server error.

```ts
import { assertRequestUnderLimit, MAX_REQUEST_BYTES } from "hai-agents";

assertRequestUnderLimit({ body: { agent: "h/web-surfer-holo3-1-35b", messages } });
console.log(`limit: ${MAX_REQUEST_BYTES} bytes`);
```

## Documentation

- [Agent API documentation](https://hub.hcompany.ai/agent-api): guides, core concepts, and the full API reference
- [Developer portal](https://portal.hcompany.ai): manage API keys and usage
- [H Company](https://hcompany.ai)

## License

[MIT](LICENSE)
