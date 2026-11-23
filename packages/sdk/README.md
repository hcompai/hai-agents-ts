<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/hcompai/hai-agents-ts/blob/main/assets/banner-dark.gif?raw=true" />
    <img src="https://github.com/hcompai/hai-agents-ts/blob/main/assets/banner-light.gif?raw=true" alt="Agents API" width="700" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/npm/v/hai-agents.svg" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/hai-agents"><img src="https://img.shields.io/node/v/hai-agents.svg" alt="Node version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  TypeScript SDK for <a href="https://hcompany.ai">H Company</a>'s <a href="https://hub.hcompany.ai/agents-api/introduction">Agents API</a>.
</p>

<p align="center">
  <b><a href="https://hub.hcompany.ai/agents-api/introduction">Documentation</a></b>
  &nbsp;·&nbsp;
  <a href="https://platform.hcompany.ai/settings/api-keys">Get an API key</a>
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

Node.js 20.4 or newer is required. Get an API key at [platform.hcompany.ai/settings/api-keys](https://platform.hcompany.ai/settings/api-keys) and export it:

```bash
export HAI_API_KEY=hk-...
```

## Quickstart

Launch the built-in `h/web-surfer-pro` agent, which ships with its own browser, and describe the task in plain language. `runSession` polls until the agent finishes and returns the final answer.

```ts
import { Client } from "hai-agents";

const client = new Client(); // reads HAI_API_KEY from the environment

const result = await client.runSession({
  agent: "h/web-surfer-pro",
  messages: "What are the top 3 stories on Hacker News right now?",
});

console.log(result.status); // "completed"
console.log(result.answer);
```

`result` is a `SessionRunResult`: `id`, `status`, `answer`, the accumulated `events`, and `finalChanges`.

## Run the agent on this machine

Three things each run either in H's cloud or on this machine, independently of each other: the agent itself (the brain, this section), its environments (the browser, next section) and inference (the model). The default is everything in the cloud. The brain can run here with the browser here; the brain can stay in the cloud while the browser is here; a local brain cannot use a cloud browser. Inference is hosted by H unless a local brain is pointed at a model server you host.

`new Client()` runs the agent in H's cloud. `Client.local()` runs it on this machine, in the same agent runtime binary the Python SDK's `Client.local()` uses. The session you pass is the same in both cases, so a task written for one runs on the other unchanged.

```ts
import { Client } from "hai-agents";

await using client = await Client.local({ download: true }); // starts, or attaches to, the agent runtime on this machine
console.log(client.localRuntime?.version, client.localRuntime?.baseUrl);

const result = await client.runSession({
  agent: { name: "qa", description: "...", environments: [{ id: "browser", kind: "web", host: "user_device" }] },
  messages: "Check that the login form appears",
});
// `await using` closes the client at the end of the block (`Symbol.asyncDispose` is Node 20.4+; the syntax itself needs TypeScript 5.2+, or Node 24+), as the Python SDK's `with Client.local() as client:`; `await client.close()` does the same by hand.
```

Two things differ from the cloud client. The runtime takes inline agent definitions only, not catalog names. And its environments are the ones on this machine, `host: "user_device"`, each served by a browser this client starts here (next section). A cloud browser (`host: "cloud"`) cannot be provisioned from a local runtime outside H's network.

The runtime is a compiled binary of about 70 MB, pinned by this SDK. It is never downloaded behind your back: pass `download: true` once and it lands under `~/.hai/agent-runtime`, or put `hai-agent-runtime` on PATH. The download honours `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, as the Python SDK's does. Start one runtime per port at a time; a second process attaches to it once it is up. The runtime reads `HAI_API_KEY` for hosted inference. `Inference.selfHosted(url, model)` points it at a model server you host instead, and withholds the key from it:

```ts
import { Client } from "hai-agents";
import { Inference } from "hai-agents/local";

const client = await Client.local({
  inference: Inference.selfHosted("http://127.0.0.1:8000/v1", "holo4-35b-a3b"),
  port: 18795, // optional: how the runtime starts, see LocalRuntimeOptions
});
```

`Client.local()` is Node.js only: the launcher lives in the `hai-agents/local` entry, which the main entry loads on demand. A runtime your process started stops when the process exits, or earlier on `client.close()`. A second process on the same port attaches to the running runtime instead of starting another.

### Serve a browser on this machine

A `user_device` environment is a browser your process drives. Give an agent one, `{ kind: "web", host: "user_device" }`, and `Client` starts the browser here when the session is created: a `PlaywrightBrowserBridge` on a Chrome of this machine, as the Python SDK's browser bridge, which attaches to a Chrome already listening on the remote-debugging port (9222), or launches Google Chrome on the `~/.hai/chrome-profile` profile, where sign-ins persist between runs. It needs the `hai-drivers` and `playwright-core` packages installed beside the SDK (`npm install hai-drivers playwright-core`; neither is pulled in by default). The same works for both brains: `new Client({ apiKey })` runs the agent in H's cloud with the browser here, `Client.local()` runs both here. It needs Node.js; in a browser the client has no bridges.

```ts
import { Client } from "hai-agents";

const client = new Client({ baseUrl: "https://agp.eu.hcompany.ai" }); // or await Client.local()
try {
  const result = await client.runSession({
    agent: {
      name: "qa",
      description: "...",
      environments: [{ id: "browser", kind: "web", host: "user_device" }],
    },
    messages: "Check that the login form appears",
  });
  console.log(result.answer);
} finally {
  await client.close(); // cancels a session still served from here; the bridge stops with the session
}
```

The bridge stops when the session ends, and the session is cancelled if the bridge dies or its browser closes, so a run never burns steps against a browser that is gone. A serving bridge keeps the process up (its long poll is always in flight), so end the run with `client.close()` or `await using`: the Python SDK's bridges run on daemon threads and its sessions are cancelled at interpreter exit, where Node's `beforeExit` reaches only the sessions whose bridges already stopped (a kill reaches none). A session created without `maxSteps` / `maxTimeS` gets 150 steps and 30 minutes, the Python SDK's runaway guards. A catalog agent is served the same way: the SDK reads its spec and routes the `user_device` environment through an override. An environment that already carries a `sessionId` is yours: nothing starts for it. `new Client({ autoBridges: false })` turns the whole thing off.

Underneath, `PlaywrightBrowserBridge` is a `LocalBridge`, which registers the command channel with the brain, long-polls it and hands each command to a driver. Drivers come from the `hai-drivers` package, the Node.js counterpart of the Python wheel the Python SDK uses: `hai-drivers/web/playwright` drives a Playwright browser. The advanced path keeps the auto bridges and gives them a browser of yours: `autoBridges: { web }` builds the bridge of each `user_device` web environment with the options your factory returns. A Playwright `context` you launched (headless, Firefox or WebKit, a device preset) replaces the Chrome of this machine, and the SDK leaves it open; a `driver` factory builds hai-drivers' driver on it with its hooks (`tabs`, `beforeClick`, `onAction`); `onCommand` sees each command before it runs; `viewport` sizes the screenshots. A bridge on its own context serves beside the others, so several sessions run from one process, where the shared Chrome serves one session at a time (the Python SDK's rule). These three are ahead of the Python SDK, whose bridges take no options.

```ts
import { Client } from "hai-agents";
import { PlaywrightWebDriver } from "hai-drivers/web/playwright";
import { chromium } from "playwright-core";

const viewport = { width: 1280, height: 800 };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport });

const client = new Client({
  baseUrl: "https://agp.eu.hcompany.ai", // or `await Client.local({ autoBridges: { ... } })`
  autoBridges: {
    web: (environment) => ({
      context, // yours: driven here, never closed here
      viewport,
      driver: (context) => new PlaywrightWebDriver(context, { viewport, onAction: (action) => console.log(action.type) }),
      onCommand: (name) => console.log(name), // the args carry what the agent types; log them only where that is wanted
    }),
  },
});
try {
  const result = await client.runSession({
    agent: {
      name: "qa",
      description: "...",
      environments: [{ id: "browser", kind: "web", host: "user_device" }],
    },
    messages: "Check that the login form appears",
  });
  console.log(result.answer);
} finally {
  await client.close();
  await browser.close();
}
```

The same options go to a bridge you start yourself, `new PlaywrightBrowserBridge({ baseUrl, apiKey, context, driver, onCommand })`, whose `sessionId` you stamp on the environment; `new LocalBridge({ baseUrl, apiKey, driver })` is the bare loop on a driver you built. A product with its own tab bookkeeping passes a `TabManagerInterface` implementation as the driver's `tabs` instead of the default `TabManager`.

## How a session works

A session is one run of an agent against a task. It moves through a small set of states: `pending`, `running`, and then a settled state such as `completed`, `idle`, `failed`, `timed_out`, or `interrupted`.

You drive a session two ways. `runSession` creates it and resolves once it settles, which suits one-shot tasks. `startSession` creates it and returns a handle right away, so you can read and steer the agent while it works.

```ts
const session = await client.startSession({
  agent: "h/web-surfer-pro",
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
  agent: "h/web-surfer-pro",
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
import { Client } from "hai-agents";
import { z } from "zod";

const Jobs = z.object({
  jobs: z.array(z.object({ title: z.string(), company: z.string() })),
});

const client = new Client();
const result = await client.runSession({
  agent: "h/web-surfer-pro",
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
import { Client, tool } from "hai-agents";

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

const client = new Client();

const result = await client.runSession({
  agent: "h/web-surfer-pro",
  messages: "What should I wear in Paris today?",
  tools: [getWeather],
});

console.log(result.answer);
```

Tool functions may be sync or async. A tool that throws is reported to the agent as a tool error rather than crashing the run.

### Prebuilt: one-time passwords (2FA)

The SDK ships ready-made tools. `otpTool` lets the agent ask for a one-time password, verification code, or confirmation link when a login or signup step needs one. Without a handler it prompts on stdin; `imapOtpHandler` reads the code straight from a mailbox over IMAP (requires the optional dependencies `imapflow` and `mailparser`; for Gmail, use an app password).

```ts
import { Client, imapOtpHandler, otpTool } from "hai-agents";

const handler = imapOtpHandler({
  host: "imap.gmail.com",
  username: "agent-inbox@gmail.com",
  password: process.env.GMAIL_APP_PASSWORD!,
});

const client = new Client();
const result = await client.runSession({
  agent: "h/web-surfer-pro",
  messages: "Log in to example.com and check for new notifications",
  tools: [otpTool({ handler })],
});
```

Like every custom tool, the handler runs entirely in your process: the IMAP credentials never leave your machine, and the agent only receives the single extracted code or link -- never mailbox contents.

## Browser profiles and vaults

Start a session on a browser that already knows the user. A [browser profile](https://hub.hcompany.ai/agents-api/browser/profiles) restores saved cookies and storage from an earlier session, and a [vault](https://hub.hcompany.ai/agents-api/vaults/overview) lets the agent sign in to sites with secrets that never enter its context. Bind both through per-run overrides:

```ts
const result = await client.runSession({
  agent: "h/web-surfer-pro",
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
import { Client, HaiAgentsEnvironment } from "hai-agents";

const client = new Client({ environment: HaiAgentsEnvironment.Us });
// or
const client = new Client({ baseUrl: "https://agp.hcompany.ai", apiKey: "hk-..." });
```

## Errors

```ts
import { HaiAgentsError, HaiAgentsTimeoutError, AnswerValidationError } from "hai-agents";
```

`HaiAgentsError` is the base for HTTP failures and carries `.statusCode` and `.body`. `HaiAgentsTimeoutError` is thrown when a request exceeds its time budget. `HaiAgents.UnprocessableEntityError` is the 422 raised when a request fails validation. `AnswerValidationError` is thrown when a completed answer does not match `answerSchema`, with the unparsed value on `.raw`.

## Webhooks

Verify the signature on an incoming webhook before trusting it (server side, Node.js 20.16 or newer):

```ts
import { verifyWebhook, WebhookVerificationError } from "hai-agents";

const event = verifyWebhook(rawBody, signature, timestamp, secret);
console.log(event.type, event.data);
```

## Documentation

Guides, core concepts, and the full API reference live at **[hub.hcompany.ai/agents-api](https://hub.hcompany.ai/agents-api/introduction)**.

## License

[MIT](LICENSE)
