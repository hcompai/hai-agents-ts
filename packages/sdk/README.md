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

## Installation

```bash
npm install hai-agents
```

Requires Node.js 18 or newer. Grab an API key at [portal.hcompany.ai](https://portal.hcompany.ai).

## Quickstart

List the agents available to your account, then launch one with a task described in plain language. Built-in agents, such as a web surfer that ships with its own browser, live under the `h/` namespace. `runSessionUntilDone` polls until the agent finishes and returns the final answer.

```ts
import { HaiAgentsClient, runSessionUntilDone } from "hai-agents";

const client = new HaiAgentsClient({ token: process.env.H_API_KEY });

const { items: agents } = await client.agents.listAgents();

const result = await runSessionUntilDone(client, {
  body: {
    agent: agents[0].name,
    messages: "What are the top 3 stories on Hacker News right now?",
  },
});

console.log(result.status); // "completed"
console.log(result.answer);
```

Streaming progress, steering a live session, regions, structured output, and error handling are all covered in the documentation.

## Documentation

Guides, core concepts, and the full API reference live at **[hub.hcompany.ai/agent-api](https://hub.hcompany.ai/agent-api)**.

- [Quickstart](https://hub.hcompany.ai/agent-api/quickstart)
- [Observe and steer a session](https://hub.hcompany.ai/agent-api/observe-and-steer)
- [Multi-agent orchestration](https://hub.hcompany.ai/agent-api/multi-agent)

## License

[MIT](LICENSE)
