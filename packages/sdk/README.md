<p align="center">
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/npm/v/hai-agents.svg" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

# hai-agents

TypeScript SDK for [H Company's Agent Platform](https://hcompany.ai). A fully typed, class-based client covering sessions, agents, memories, skills, and environments.

## Install

```bash
npm install hai-agents
```

Requires Node.js 18 or newer. Grab an API key at [portal.hcompany.ai](https://portal.hcompany.ai).

## Quickstart

```ts
import { HaiAgentsClient } from "hai-agents";

const client = new HaiAgentsClient({ token: process.env.H_API_KEY });

const session = await client.sessions.createSession({
  body: {
    agent: "h/web",
    messages: "What is the H1 on example.com?",
    maxSteps: 10,
    maxTimeS: 150,
  },
});

console.log(session.id);
```

## Run a task to completion

`runSessionUntilDone` creates a session and polls until the agent reaches a
terminal state, returning the terminal `status`, accumulated events, and final answer.

```ts
import { runSessionUntilDone } from "hai-agents";

const result = await runSessionUntilDone(client, {
  body: { agent: "h/web", messages: "What is the H1 on example.com?" },
  timeoutMs: 180_000, // overall wall-clock budget
  pollBackoffMs: 1_000, // delay between polls, on top of the server long-poll
  includeEvents: true, // set false to poll status only, without streaming events
});

console.log(result.status, result.answer);
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

## Messages and feedback

```ts
await client.sessions.sendSessionMessages({
  id: session.id,
  body: { type: "user_message", message: "Keep the answer under one sentence." },
});

await client.sessions.submitSessionFeedback({
  id: session.id,
  body: { success: true, message: "The answer matched the page heading." },
});
```

## Cancelling a session

`cancelSession` asks the platform to interrupt the run. The session may still
report `running` briefly while the worker stops; poll until it reaches a terminal
state such as `interrupted`.

```ts
await client.sessions.cancelSession({ id: session.id });
```

## Request size limit

The platform rejects request bodies above 5MB. `runSessionUntilDone` enforces
this on the create payload; for ad-hoc requests, validate first to fail fast with
a clear message instead of a server error.

```ts
import { assertRequestUnderLimit, MAX_REQUEST_BYTES } from "hai-agents";

assertRequestUnderLimit({ body: { agent: "h/web", messages } });
console.log(`limit: ${MAX_REQUEST_BYTES} bytes`);
```
