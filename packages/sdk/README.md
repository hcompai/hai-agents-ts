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

```ts
import { createSession, getSessionChanges } from "hai-agents";

const baseUrl = "https://agp.eu.hcompany.ai";
const auth = process.env.HAI_API_KEY;
const agent = process.env.HAI_AGENT_ID;

if (!auth) {
  throw new Error("Set HAI_API_KEY");
}

if (!agent) {
  throw new Error("Set HAI_AGENT_ID to the agent catalog id you want to run");
}

const session = await createSession({
  baseUrl,
  auth,
  body: {
    agent,
    messages: "Open https://example.com and report the page title.",
  },
});

if (session.error) {
  throw new Error(JSON.stringify(session.error));
}

const changes = await getSessionChanges({
  baseUrl,
  auth,
  path: { id: session.data.id },
  query: { wait_for_seconds: 10 },
});

if (changes.error) {
  throw new Error(JSON.stringify(changes.error));
}

console.log(changes.data.answer);
```
