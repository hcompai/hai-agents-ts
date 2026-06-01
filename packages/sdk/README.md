<p align="center">
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/npm/v/hai-agents.svg" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

# hai-agents

TypeScript SDK for [H Company's Agent Platform](https://hcompany.ai). A fully typed client covering sessions, agents, memories, skills, and environments.

## Install

```bash
npm install hai-agents
```

Grab an API key at [portal.hcompany.ai](https://portal.hcompany.ai).

## Usage

Every operation takes per-call options. Set `baseUrl` to the Agent Platform and
provide your `hk-...` key via the `auth` callback:

```ts
import {
  cancelSession,
  createSession,
  getSessionStatus,
  getSessionChanges,
} from "hai-agents";

const config = {
  baseUrl: "https://agp.eu.hcompany.ai",
  auth: () => process.env.H_API_KEY!,
};

// Start a browsing session with the hosted `h/web` agent.
const { data: session } = await createSession({
  ...config,
  body: {
    agent: "h/web",
    messages: [{ type: "user_message", message: "What is the H1 on example.com?" }],
    max_steps: 10,
    max_time_s: 150,
  },
});

const sessionId = session!.id;

// Poll until the session reaches a terminal state.
const terminal = new Set(["completed", "failed", "timed_out", "interrupted"]);
let status = session!.status.status;
while (!terminal.has(status)) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const { data } = await getSessionStatus({ ...config, path: { id: sessionId } });
  status = data!.status;
}

// Read the agent's final answer.
const { data: changes } = await getSessionChanges({
  ...config,
  path: { id: sessionId },
  query: { from_index: 0 },
});
console.log(changes!.answer);
```

## Cancelling a session

`cancelSession` asks the platform to interrupt the run. The response confirms
that the request was accepted; the session may still report `pending` or
`running` briefly while the worker stops. Poll status until it reaches a
terminal state such as `interrupted`.

```ts
await cancelSession({ ...config, path: { id: sessionId } });

let cancelledStatus = "running";
while (!terminal.has(cancelledStatus)) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const { data } = await getSessionStatus({ ...config, path: { id: sessionId } });
  cancelledStatus = data!.status;
}

console.log(cancelledStatus);
```
