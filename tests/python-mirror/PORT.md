# How this port maps to the Python `tests/`

Every file here started as a literal transcription of its Python counterpart, then imports, class names
and method names were rewired to the real SDK API. Everything that is not a straight port is listed below.

## Where the two SDKs stand

Written for the stack as it ships: hai `node-web-driver` (the `hai-drivers` npm package), `python-mirror` (this
suite, the drift check and this ledger: the spec of the two branches above it), `ts-local-launcher` (`hai-agents/local`:
the runtime launcher), `ts-local` (`LocalBridge` + `CommandExchange`, the ready-made browser bridge, auto bridges), and
a product built on both, outside the SDKs. The "In TS" column names the branch that brings each piece until it is on
`main`.

Two words to keep apart, because the Python package name `hai_agents_local` covers both. A **local runtime**
(the Python README's "Local agents": `Client.local()`, `holo --local`; TS `Client.local()` from `hai-agents`) runs the agent loop on
this machine in the `hai-agent-runtime` binary; only model calls leave it. A **bridge** (`hai_agents_local`'s
bridge modules, `holo local`; TS `LocalBridge`) leaves the loop wherever it runs, H's cloud or a local runtime,
and executes its browser / desktop / shell commands on this machine through `hai-drivers`. The two combine
freely except one way: a local runtime cannot use a cloud browser.

```text
                              the browser / desktop / shell runs in
                              H's cloud                    this machine (LocalBridge + hai-drivers)
                             ┌────────────────────────────┬──────────────────────────────────────────┐
  the agent loop   H's cloud │ default                    │ local control                            │
  runs in                    │ Client() in both SDKs      │ Client() + LocalBridge                   │
                             │                            │ holo local                               │
                             ├────────────────────────────┼──────────────────────────────────────────┤
                this machine │ not possible: a local      │ local runtime                            │
                (runtime)    │ runtime cannot provision   │ Client.local() + LocalBridge             │
                             │ a cloud browser            │ Client.local(), holo --local             │
                             └────────────────────────────┴──────────────────────────────────────────┘
  Model calls go to H in every cell, or to a server you host (Inference.selfHosted / Inference.self_hosted).

  One command, right column:
  agent loop ──command──▶ command channel ◀──long-poll── LocalBridge ──dispatch──▶ hai-drivers driver ──▶ browser
             ◀──result───  (AGP or the      ──post result─▶
                            local runtime)
```

The Python repo ships five packages (`pyproject.toml`, `packages`); the TS repo ships one, `hai-agents`, with a
Node-only entry `hai-agents/local`. The driver layer lives in the hai repo in both languages: the `hai-drivers`
wheel and the `hai-drivers` npm package (`hai_drivers/node`).

| Python | What it is | In TS |
| --- | --- | --- |
| `hai_agents` | Generated API client + `run_session` / `wait_for_session` / tools / webhooks; `Client.local()` binds it to a local runtime; `Client()` and `Client.local()` both auto-start bridges; `with Client.local() as client:` | `hai-agents` (`packages/sdk`); `Client.local()` on the same `Client`, which loads the Node-only `hai-agents/local` entry on demand (`ts-local-launcher`); `await using client = await Client.local()` (`[Symbol.asyncDispose]`, the TS idiom for the context manager); `Client()` and `Client.local()` both auto-start bridges under Node, where the auto-bridge layer loads lazily; in a browser the client has no bridges (`ts-local`); `autoBridges` also takes a product's per-environment bridge options (ts-ahead, below) |
| `hai_agents_tools` | Prebuilt tools (today: the OTP / 2FA code reader) | yes: `src/tools/otp.ts` |
| `hai_agents_cli` | The `holo` / `hai` terminal command: login, run a task, steer it, MCP server install, `doctor`, `holo local` | no |
| `hai_agents_common` | Helpers the CLI shares: the credentials store, JSON coercion | no |
| `hai_agents_local/runtime/` | Downloads, verifies (`pin.json`) and starts the `hai-agent-runtime` binary; `Inference` for a self-hosted model | `src/local/runtime.ts`, `process.ts`, `install.ts`, `manifest.ts`, `state.ts`, `inference.ts`, `pin.json` (`ts-local-launcher`) |
| `hai_agents_local/bridge.py`, `transport.py` | The command loop: register a channel, long-poll it, hand each command to a driver, post the result; 429 backoff, bounded result retries, bytes as base64 | `src/local/bridge.ts` (`LocalBridge`), `src/local/transport.ts` (`CommandExchange`) (`ts-local`) |
| `hai_agents_local/browser.py` (Selenium), `desktop.py`, `workstation.py` | One ready-made bridge per environment kind: the loop composed with a driver | `src/local/browser.ts` (`PlaywrightBrowserBridge`, `ts-local`); no desktop or workstation driver in Node, so no desktop or workstation bridge; ahead of Python: a caller's Playwright `context` and a `driver` factory (below) |
| `hai_agents_local/routing.py` | Which environment of an agent tree gets a bridge: inline `user_device` ones are stamped with the bridge's session id, named ones routed by an override; a seed makes the ids reproducible | `src/local/routing.ts` (`ts-local`), web only: a desktop or workstation environment is refused with the unsupported-kind error; ahead of Python: `bridgeOptions`, the product's options for each bridge the walk builds (below) |
| `hai_agents_local/config.py` | The environment variables: `HAI_API_BASE_URL`, `HAI_AUTO_BRIDGE`, the shell desktop's | `src/local/config.ts` (`ts-local`); the shell desktop variables are not there |
| `hai_agents_local/manager.py` | The process-wide bridge manager: one bridge per kind, the newest session takes a kind over, a crash after startup fires the bridge's loss handler | `src/local/manager.ts` (`ts-local`): each bridge is its `start()` promise on the event loop, where Python runs a daemon thread per bridge, so a serving bridge keeps the process up until `close()` where Python's interpreter exits under its thread and atexit cancels (the poll stays ref'd by decision); its `TimeoutError` (a bridge that does not confirm its stop; Python raises the builtin) is exported from `hai-agents/local`; ahead of Python: a bridge that is not `exclusive` (its own browser) serves beside the others, N sessions per process (below) |
| `hai_agents_local/sessions.py` | Auto bridges: the sessions client that starts a bridge for each `user_device` environment, stamps its session id, cancels the session when the bridge dies and at interpreter exit, stops the bridges when the session ends; the runaway budgets | `src/local/sessions.ts` (`LocalSessionsClient`, `ts-local`), the `sessions` of `Client` under Node, for a cloud brain (`new Client({ apiKey })`) and a local one (`Client.local()`); no kill switch, no desktop preflight, no `own_session_ids` (no idle check) |
| `hai_agents_local/killswitch.py`, `desktop_lock.py` | The double-Esc kill switch, one agent per desktop | no: web only, no terminal UI |
| `hai_drivers` wheel (hai repo): `web` interface + Playwright and Selenium drivers, `desktop`, `code_sandbox`, `mobile` | What a bridge hands each command to | `hai-drivers` npm (hai `node-web-driver`): `hai-drivers/web` (interface, `WebDriverBase`) and `hai-drivers/web/playwright` (`PlaywrightWebDriver`); web only |

Both clients are generated from the same spec: the platform's sync landed on `main` (SDK 1.5.1), regenerating the TS
client from the export that produced the Python client, with `tool_approvals` and the environment / skill revisions.
The platform's hand-written overlays (`polling.ts`, `tools.ts`, `webhookVerification.ts`, `oo.ts`, the two error
classes, `requestWithRetries.ts`; see Overlay-owned sources) reach this repo through its next client sync; this branch
changes nothing under `src/client`.

### Decisions

AGENTS.md sets the rule: mirror hai-agents-python, with two allowed exceptions, each commented on the spot. Every
difference this file and `parity-exceptions.json` record falls under one of these kinds:

- `node-forced`: Node forces it: no sync I/O in the loop, `fetch` for httpx, one event loop, no `flock`, milliseconds.
- `ts-idiom`: a TypeScript idiom: zod for pydantic, plain objects for dicts and models, the option name the TS user
  typed (`apiKey`, `maxPolls`), a private helper inlined.
- `decided-out`: out of scope by design (AGENTS.md, Boundaries): desktop, mobile, workstation, the CLI and its
  credentials store, the kill switch.
- `deferred`: not in this batch. Either a paired change (a platform PR that ships with the `ts-local` PR) or a later
  PR: the startup lock's siblings, re-acquire, idle shutdown and the spawn registry.
- `python-only-feature`: a primitive TS cannot have: type hints for a tool's schema, `*args` introspection.
- `ts-ahead`: TS goes first by decision, with a Python follow-up recorded; the
  regexes cannot see an option field or a method, so these are `kind: "addition"` entries, never DRIFT, never stale,
  listed in PARITY.md. The first batch, each stated in the file header: `PlaywrightBrowserBridgeOptions.context`
  and `.driver` (browser.ts: a product serves a Playwright context it owns with a driver it hooks; Selenium cannot take
  one), `autoBridges: true | false | { web?: (environment) => WebBridgeOptions }` (oo.ts, index.ts, sessions.ts,
  routing.ts `bridgeOptions`: a product's per-environment options on the auto path; Python's `auto_bridges` is a
  bool), `ManagedBridge.exclusive` (manager.ts: a bridge on its own browser is keyed by its session id alone and never
  displaces or is displaced, N sessions per process; the shared-Chrome bridges keep Python's one-per-kind rule).
  Two differences of the same batch are stated on the spot only, with no entry: `Client[Symbol.asyncDispose]` is a
  TS idiom (`await using`, Python's `with Client.local() as client:`), and the launcher's exit handler removing an
  owned runtime's state files (runtime.ts; Python's atexit calls `shutdown()` only) names no module-level addition.
  Python follow-ups: a `create_driver` hook and a `bridge_options` argument, an `exclusive` flag read by
  `_displace_kind`, the state files at atexit.

A platform ask (a change to an overlay, `src/client`) goes to agent_platform, not to this repo.

## Ledger (generated)

`pnpm drift` (`tests/python-mirror/drift.mjs`) reads the Python sources in place, at the commit `parity.json` pins (the
run stops if the checkout is elsewhere), and compares each module and test file of `parity.json` with its TS mirror:
names, constants, error texts, test names. Every `.py` file under the Python directories `parity.json` lists as its
`scope` must have an entry, mapped or with a reason, or the run stops. Every difference is on record in
`parity-exceptions.json` with one of the six reasons of the Decisions subsection, or it is DRIFT and `pnpm drift --check`
fails. In the test table a Python test ported by a file in `pending/` counts under Pending and one that runs on a
condition (`describe.skipIf`, the live suite) under skipIf, not under Ported. Between the markers is its output (`pnpm drift --write`): the per-file counts, what is pending and the open DRIFT list. Every difference
on record, with its reason, is in the generated [PARITY.md](PARITY.md). The prose around the markers is hand-written.

The scope is the whole of both SDKs on every branch of the stack: `python-mirror` is the spec, and its `parity.json`,
`parity-exceptions.json` and tests already cover every module and test file the stack ports. A test whose subject a
later branch brings waits in `pending/` (`tests/python-mirror/pending/`; `packages/sdk/tests/pending/` for the TS-only
ones), outside the typecheck and the run, and that branch `git mv`s it into place; an exception about code a later
branch adds to a file already in place names a file of that branch in `landsWith`. drift compares a pending test file
all the same and lists what is not in place under Pending, and `--check` fails while anything is pending. A module pair
whose TS file is in place but still the generator's output, the overlays not synced yet, says so in its own `landsWith`
(a note, not a path) and is listed as pending, not compared. So it is red by design on `python-mirror`: the
overlay-owned `src/client` pairs and the tests of what the overlays carry (`*_overlay.test.ts`) wait for the platform's
client sync, the `hai_agents_local/runtime/` modules and their tests wait for `ts-local-launcher`, and the bridge,
transport, browser, routing, manager, sessions and config modules, `test_local.py` and the two bridge tests of
`test_runtime_placement.py` wait for `ts-local`. `ts-local-launcher` carries the generator's overlay output, so the
`src/client` pairs and the overlay tests are compared and run there and only the `ts-local` part remains; on `ts-local`
the check is green. Each branch regenerates this section, so its diff shows the gaps it closes.

<!-- drift:begin -->
Generated by `pnpm drift --write`; edit parity.json / parity-exceptions.json, not this section.

| Python module | TS mirror | Names | Constants | Errors |
| --- | --- | --- | --- | --- |
| `hai_agents/client.py` | `client/oo.ts` | 8 excepted | 0 excepted | 2 excepted |
| `hai_agents/polling.py` | `client/polling.ts` | 11 excepted | 0 excepted | 18 excepted |
| `hai_agents/tools.py` | `client/tools.ts` | 2 excepted | 0 excepted | 4 excepted |
| `hai_agents/webhook_verification.py` | `client/webhookVerification.ts` | 0 excepted | 0 excepted | 2 excepted |
| `hai_agents/core/api_error.py` | `client/errors/HaiAgentsError.ts` | 3 excepted | 0 excepted | 0 excepted |
| `hai_agents/core/http_client.py` | `client/core/fetcher/requestWithRetries.ts`, `client/core/fetcher/Fetcher.ts`, `client/core/fetcher/createRequestUrl.ts`, `client/core/fetcher/getRequestBody.ts` | 17 excepted | 0 excepted | 1 excepted |
| `hai_agents_tools/otp.py` | `tools/otp.ts`, `html.ts` | 3 excepted | 0 excepted | 3 excepted |
| `hai_agents_local/bridge.py` | `local/bridge.ts` (pending) | pending | pending | pending |
| `hai_agents_local/transport.py + hai_agents_local/errors.py` | `local/transport.ts` (pending) | pending | pending | pending |
| `hai_agents_local/browser.py` | `local/browser.ts` (pending) | pending | pending | pending |
| `hai_agents_local/routing.py` | `local/routing.ts` (pending) | pending | pending | pending |
| `hai_agents_local/manager.py` | `local/manager.ts` (pending) | pending | pending | pending |
| `hai_agents_local/sessions.py` | `local/sessions.ts` (pending) | pending | pending | pending |
| `hai_agents_local/config.py` | `local/config.ts` (pending) | pending | pending | pending |
| `hai_agents_local/desktop.py` | none (decided-out: no desktop driver in Node) |  |  |  |
| `hai_agents_local/workstation.py` | none (decided-out: no workstation driver in Node) |  |  |  |
| `hai_agents_local/killswitch.py` | none (decided-out: no terminal UI, no kill switch) |  |  |  |
| `hai_agents_local/desktop_lock.py` | none (decided-out: one agent per desktop: desktop only) |  |  |  |
| `hai_agents_cli/` | none (decided-out: no CLI) |  |  |  |
| `hai_agents_common/` | none (decided-out: the CLI's credentials store and JSON coercion) |  |  |  |
| `hai_agents_local/runtime/runtime.py` | `local/runtime.ts` | 7 excepted | 0 excepted | 9 excepted |
| `hai_agents_local/runtime/acquire.py` | `local/index.ts` | 4 excepted | 0 excepted | 1 excepted |
| `hai_agents_local/runtime/errors.py` | `local/errors.ts` | 0 excepted | 0 excepted | 0 excepted |
| `hai_agents_local/runtime/identity.py` | `local/identity.ts` | 9 excepted | 0 excepted | 2 excepted |
| `hai_agents_local/runtime/inference.py` | `local/inference.ts` | 1 excepted | 0 excepted | 0 excepted |
| `hai_agents_local/runtime/install.py` | `local/install.ts`, `local/zip.ts` | 3 excepted | 0 excepted | 23 excepted |
| `hai_agents_local/runtime/manifest.py` | `local/manifest.ts` | 3 excepted | 0 excepted | 3 excepted |
| `hai_agents_local/runtime/process.py` | `local/process.ts` | 6 excepted | 0 excepted | 2 excepted |
| `hai_agents_local/runtime/state.py` | `local/state.ts` | 3 excepted | 0 excepted | 0 excepted |

| Python test file | TS mirror | `def test_` | Ported | Pending | skipIf | Adapted | Dropped | DRIFT | TS-only |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `tests/test_answer_schema.py` | `answer_schema.test.ts`, `answer_schema_overlay.test.ts` | 18 | 16 | 0 | 0 | 1 | 1 | 0 | 0 |
| `tests/test_bump_runtime.py` | `bump_runtime.test.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_fetch_policy.py` | `fetch_policy.test.ts`, `fetch_policy_overlay.test.ts` | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 1 |
| `tests/test_local.py` | `local_bridge.test.ts` (pending), `local_sessions.test.ts` (pending) | 89 | 0 | 54 | 0 | 1 | 34 | 0 | 0 |
| `tests/test_otp.py` | `otp.test.ts` | 22 | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_polling_helpers.py` | `polling_helpers.test.ts` | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_release_scripts.py` | `release_scripts.test.ts`, `release_scripts_session_fields.test.ts` | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_runtime_placement.py` | `runtime_placement.test.ts`, `runtime_placement_bridges.test.ts` (pending) | 17 | 7 | 2 | 0 | 0 | 8 | 0 | 0 |
| `tests/test_runtime_state.py` | `runtime_state.test.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| `tests/test_settle.py` | `settle.test.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_smoke.py` | `smoke.test.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_spec_defaults.py` | `spec_defaults.test.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_tools_package.py` | `tools_package.test.ts` | 4 | 3 | 0 | 0 | 0 | 1 | 0 | 0 |
| `tests/test_tools.py` | `tools.test.ts`, `tools_overlay.test.ts` | 15 | 12 | 0 | 0 | 2 | 1 | 0 | 5 |
| `tests/test_webhook_verification.py` | `webhook_verification.test.ts`, `webhook_verification_overlay.test.ts` | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| `tests/test_cli.py` | none (decided-out: no CLI) | 34 | 0 | 0 | 0 | 0 | 34 | 0 | 0 |
| `tests/test_cli_ui.py` | none (decided-out: no CLI) | 11 | 0 | 0 | 0 | 0 | 11 | 0 | 0 |
| `tests/test_cli_prompt.py` | none (decided-out: no CLI) | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| `tests/test_cli_keys.py` | none (decided-out: no CLI) | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| `tests/test_cli_drift.py` | none (decided-out: no CLI) | 5 | 0 | 0 | 0 | 0 | 5 | 0 | 0 |
| `tests/test_credentials.py` | none (decided-out: no credentials store, the client takes apiKey only) | 17 | 0 | 0 | 0 | 0 | 17 | 0 | 0 |
| `tests/test_mcp_install.py` | none (decided-out: no MCP server install (CLI)) | 15 | 0 | 0 | 0 | 0 | 15 | 0 | 0 |
| `tests/test_workstation_clis.py` | none (decided-out: no workstation bridge) | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| `tests/test_desktop_stop.py` | none (decided-out: no desktop bridge) | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| `tests/integration/test_auth_smoke.py` | `integration/auth_smoke.test.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `tests/integration/test_session_browser.py` | `integration/session_browser.test.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `tests/integration/test_session_code_env.py` | `integration/session_code_env.test.ts` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `tests/integration/test_skills_crud.py` | `integration/skills_crud.test.ts` | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| `tests/integration/test_cli.py` | none (decided-out: no CLI) | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |

Every difference on record, with its reason, is in [PARITY.md](PARITY.md), generated with this section.

### Pending (9)

- `src/hai_agents_local/bridge.py` → `packages/sdk/src/local/bridge.ts`: not in place, not compared (Python names: 13, exceptions waiting: 6)
- `src/hai_agents_local/transport.py + src/hai_agents_local/errors.py` → `packages/sdk/src/local/transport.ts`: not in place, not compared (Python names: 19, exceptions waiting: 7)
- `src/hai_agents_local/browser.py` → `packages/sdk/src/local/browser.ts`: not in place, not compared (Python names: 7, exceptions waiting: 13)
- `src/hai_agents_local/routing.py` → `packages/sdk/src/local/routing.ts`: not in place, not compared (Python names: 17, exceptions waiting: 14)
- `src/hai_agents_local/manager.py` → `packages/sdk/src/local/manager.ts`: not in place, not compared (Python names: 7, exceptions waiting: 3)
- `src/hai_agents_local/sessions.py` → `packages/sdk/src/local/sessions.ts`: not in place, not compared (Python names: 29, exceptions waiting: 9)
- `src/hai_agents_local/config.py` → `packages/sdk/src/local/config.ts`: not in place, not compared (Python names: 14, exceptions waiting: 8)
- `tests/test_local.py` → `tests/python-mirror/local_bridge.test.ts`, `tests/python-mirror/local_sessions.test.ts`: in pending/, compared (Python tests ported there: 54)
- `tests/test_runtime_placement.py` → `tests/python-mirror/runtime_placement_bridges.test.ts`: in pending/, compared (Python tests ported there: 2)

### DRIFT (0)

None.
<!-- drift:end -->

## Dropped: no TypeScript primitive in hai-agents-ts

Counts are test functions (`def test_`), not parametrized cases.

| Python file | Tests | What the tests cover | Why there is nothing to port |
| --- | ---: | --- | --- |
| `test_cli.py`, `test_cli_ui.py`, `test_cli_prompt.py`, `test_cli_keys.py` | 48 | The `holo` / `hai` command: argument routing, the live event feed rendering, the interactive prompt (history, tab completion), Esc handling | No CLI in the TS SDK |
| `test_cli_drift.py` | 5 | The CLI only uses SDK symbols that still exist (a contract test between the two packages) | No CLI |
| `test_credentials.py` | 17 | Where the API key comes from: env var beats `.env` beats the stored login; save / clear round trip | No credentials store; the TS client takes `apiKey` only |
| `test_mcp_install.py`, `test_workstation_clis.py`, `integration/test_cli.py` | 18 | Writing the MCP server entry into Claude / Cursor config files; the three CLIs the workstation bridge hands the agent; a live CLI run | No MCP server, no workstation bridge |
| `test_local.py` (TestDoctor, TestMacosPermissionPreflight, TestKillSwitch, the two kill-switch tests of TestAutoStart), `test_desktop_stop.py` | 11 | The kill switch (double Esc) stops bridges then sessions, `doctor`, the macOS permission preflight, stop kills only the active command tree | No kill switch, doctor (it is the CLI's: `hai_agents_cli/doctor.py`), macOS preflight or desktop / workstation bridge in TS. TestLocalizeAgent (21), TestManager (11, with its module-level test), TestAutoStart (13) and the module-level stop tests (5) are ported on `ts-local`, the channel-setup, bridge-protocol and driver-interface classes (31) on `ts-local`: see the `test_local.py` sections at the end, whose Dropped tables hold the rest (the async and kill-switch tests of TestAutoStart, the workstation stop test). The Ledger counts the whole file: 54 ported, 1 adapted, 34 dropped |
| `test_runtime_placement.py` (8 of 17) | 8 | The startup lock between spawners, re-acquiring a runtime whose spawner died, the idle shutdown | Startup lock: Node has no `flock`; one runtime per port at a time is left to developers (`packages/sdk/src/local/runtime.ts`). Re-acquire and idle shutdown: not ported (deferred, see Decisions). The stored-key row of `test_spawned_runtime_infers_with_the_key_hai_login_stored` is adapted, not dropped (below). The two tests of the runtime hold's auto bridges (`test_local_client_without_auto_bridges_leaves_execution_to_the_product`, `test_bridge_never_serves_an_unproven_runtime`) are ported in `runtime_placement_bridges.test.ts` (in `pending/` until `ts-local`): a web environment for Python's desktop and workstation ones, `start()` for `run()` |
| `test_tools.py` (1 of 15) | 1 | Dispatching an async tool from inside an already-running event loop | Node has one event loop and no "sync call inside a running loop" case |
| `test_answer_schema.py` (1 of 18) | 1 | A `SessionRunResult` built without `answer` reads it back from `final_changes` | `SessionRunResult` is a plain object the loop builds, not a class: the Python test exercises the constructor's backfill, which has no TS counterpart; the behaviour it protects (no schema: the answer is the raw one from final changes, `polling.ts:563`) is covered by "no schema keeps raw answer" and "non completed status passes raw through" |
| `test_tools_package.py` (1 of 4) | 1 | Every name in `__all__` resolves to an attribute | An ESM namespace cannot carry a missing export, so the test could not fail |

## Adapted: the TS primitive differs from Python, the contract is kept

Each test carries a comment naming its Python source and what differs.

| Python test | TS test | What the test proves | What differs |
| --- | --- | --- | --- |
| `test_tools.py::test_tool_decorator_derives_schema` | `tools.test.ts` "tool with explicit schema keeps the shape the agent sees" | The tool definition the agent receives has the right name, description, properties and required list, and calling it works | Python's `@tool` builds the JSON schema from the function's type hints; TS has no runtime types, so `tool({...})` takes `inputSchema` explicitly and `Tool` is a type, not a class |
| `test_tools.py::test_tool_decorator_with_args_returns_tool_and_applies_overrides` | `tools.test.ts` "tool with a zod schema returns tool and applies overrides" | `name` / `description` overrides win over the function's own | The pydantic `input=` model becomes `z.toJSONSchema(z.object(...))` |
| `test_otp.py::test_otp_tool_default_handler_prompts_stdin` | `otp.test.ts` "otp tool default handler prompts stdin" | With no handler, the OTP tool asks the person at the terminal and the prompt text is exact | Python patches `builtins.input`; TS reads stdin through `node:readline/promises`, which `otp.ts` loads lazily via `process.getBuiltinModule`, so the test patches that loader |
| `test_runtime_placement.py::test_spawned_runtime_infers_with_the_key_hai_login_stored` | `runtime_placement.test.ts` "spawned runtime infers with the key hai login stored" | The runtime a local client spawns gets the H key for hosted inference and never for a server the caller or the shell (`HAI_AGENT_RUNTIME_BASE_URL`) selects | Python patches `ensure_started` and reads `spawn_env`; the TS runtime layer builds that env, so the test spawns the fake runtime and reads what it got. The first row's stored key (`hai login`) is the shell's `HAI_API_KEY`: no credentials store in TS |
| `test_bump_runtime.py` | `bump_runtime.test.ts` | A release pin update is complete or leaves `pin.json` unchanged | Python reads the bumped URLs back from `manifest.py`'s `MANIFEST` dict; `manifest.ts` has no dict, so the URL is composed by its `artifactUrl` from the bumped version |
| `test_spec_defaults.py` (the generated-model default check) | `spec_defaults.test.ts` "generated model sends spec default" | The const+default discriminators (`kind`, `provider`) reach the wire | Python lets the variant class supply the tag; the TS serializer takes it from the value, so the test passes `kind` / `provider` itself |

## Changed on purpose

Same behaviour, different literal, because the TS SDK was written that way:

- `maxPolls=` (Python `max_polls=`): the message names the camelCase option the TS user typed.
- `answerSchema must be a zod v4 schema` (Python: `a pydantic.BaseModel subclass`).
- Events reach the polling loop through the serde layer (camelCase in memory), so fakes emit
  `pendingToolCalls` / `toolName`; the posted body stays `tool_req` / `tool_name` as on the wire.
- Inline agents carry `answerFormat` and `inputSchema` (camelCase); override keys stay `agent.answer_format`
  and `agent.tools` because they are wire strings.
- `runtime_placement` "spawner never overwrites the live runtime token": the port is held by a server that
  cannot prove itself (instead of patching `_attach` out), which is the TS path that reaches the same guard.
- OTP IMAP tests mock `imapflow` + `mailparser` (what the TS handler uses) instead of an `imaplib` connection;
  the search is asserted as `{ seen: false, since, from }`.
- A dropped request: Python tells `httpx.ConnectError` (re-sent for any method) from `RemoteProtocolError` (idempotent
  methods only); `fetch` rejects both with a `TypeError`, told apart by `cause.code` under Node (ECONNREFUSED, ENOTFOUND,
  EAI_AGAIN = never reached the server). A browser's `Failed to fetch` carries no cause, so a TypeError without a connect
  code counts as a mid-request drop (`requestWithRetries.ts`, overlay-owned).
- `HaiAgentsError` with a server detail and no status prints `(status_code: null)` where Python's `ApiError.__str__`
  prints `(status_code: None)`: `null` is what its headers/status/body dump already prints.
- Bridge and routing errors name the option the TS user typed: `apiKey is required`, `sessionId must be a UUID`,
  `give it an explicit sessionId` (Python: `api_key`, `session_id`); the override paths in them stay `session_id`,
  a wire string. Where Python's text ends with the `holo local browser --session-id <id>` command (or
  `holo local browser|desktop` in the overrides warning), the TS text names `new PlaywrightBrowserBridge({ sessionId })`: no CLI.

## Candidates to upstream

Tests with no Python counterpart whose code path Python has too: a mirror test carries its reason in a header
comment and could be added to the Python suite as is; a `packages/sdk/tests` one is listed with its file. Tests of
what only the TS SDK does live in
`packages/sdk/tests` (browser bundle, optional IMAP dependency, the client's own timeout and non-JSON
errors, the schema title fallback, the hand-restored union tags).

| TS test | Why it exists here |
| --- | --- |
| `fetch_policy.test.ts` "connect error is resent for any method" | Python has the rule (`core/http_client.py:140-142`, `_may_resend`: a `ConnectError` is re-sent for any method) but tests only the mid-request drop |
| `tools.test.ts` "as tools rejects duplicate names" | Python has the check (`tools.py:85-87`) but no test |
| `tools.test.ts` "run session posts several results as one batch and answers an unknown tool with an error" | Python tests the post on the private helper only; the `{type: "batch"}` envelope and the unregistered-tool `error_event` through the loop |
| `tools.test.ts` "run session tolerates 409 from tool results when the session already finished" | Same; the loop accepts a 409 on the post |
| `tools.test.ts` "run session raises on a non 409 post failure" | Same; any other post failure propagates |
| `tools.test.ts` "wait with tools rejects include events false" | Python has the guard (`polling.py:578`) but no test |
| `otp.test.ts` fetch-order assertion in "imap otp handler skips message that fails to fetch or parse" | Newest message first, as the handler polls |
| `packages/sdk/tests/local.test.ts` "stops an owned runtime and removes its state files when this process exits without close()" | Python registers no exit handler: a runtime lives as long as its spawner, the parent watchdog (`acquire.py`, `RuntimeHold`); the state files it leaves and the exit path are untested there |
| `packages/sdk/tests/local.test.ts` "stops what close() stops at the end of an `await using` block" | Python's `__exit__` calls `close()` (`client.py:140`); no test of `with Client.local() as client:` |
| `packages/sdk/tests/local.test.ts` "requires a recipe only when asked, and re-probes it on attach" | Python's `require_recipe` probes `/health` the same way on attach; its test covers the wrong recipe, not the re-probe |
| `packages/sdk/tests/local.test.ts` "refuses to download a version it holds no digest for", "requires a digest alongside a download URL override" | Python has both guards (`runtime.py` "pins sha256 digests", `install.py` `DOWNLOAD_SHA256_ENV`) but no test |
| `packages/sdk/tests/local.test.ts` "routes the download through HTTPS_PROXY, as Python's httpx does", "leaves NO_PROXY hosts off the proxy" | httpx honours both by default (`trust_env`); no Python test. Not a candidate: "refuses a zip entry that escapes the destination" (Python extracts with `zipfile`, no guard) |

## Overlay-owned sources

`packages/sdk/src/client/` is regenerated by the platform's generator (agent_platform `sdk-codegen/ts/generate.sh`), which
copies `polling.ts`, `tools.ts`, `webhookVerification.ts`, `oo.ts` (`client.ts.static`), `errors/HaiAgentsError.ts`,
`errors/HaiAgentsTimeoutError.ts` and `core/fetcher/requestWithRetries.ts` from `*.static` overlays there. A change to
one of them is a platform ask, not a commit here.

`python-mirror` changes nothing under `src/client`. The behaviour its tests pin (a dropped idempotent request re-sent,
tool-result posts retrying transient statuses, the zod guard on `answerSchema`, Python's error texts, `Client` as the
client's name) lives in those overlays and reaches this repo through the platform's client sync, so those tests wait in
`pending/` (`*_overlay.test.ts`; `packages/sdk/tests/pending/clientAlias.test.ts` for the TS-only one), the mirror
reads the client's name through `client.ts`, and the `src/client` pairs are listed as pending in the Ledger
(`landsWith` in `parity.json`) until the sync lands.

`ts-local-launcher` and `ts-local` each carry copies of the generator's output for the overlay-owned files: `oo.ts`
with `Client.local()` (the launcher) and with the auto bridges (`ts-local`; `autoBridges` as `AutoBridges`, a failed
load of the local entry surfacing at the first `sessions` call), with the `index.ts` export lines its `generate.sh`
writes. Those copies are the generator's output, not hand-written code: they disappear with the sync, which the
`ts-local` PR is paired with (that script exits when `packages/sdk/src/local/index.ts` is missing). `src/local/sessions.ts`
subclasses the generated `SessionsClient` and builds `HttpResponsePromise`s, which the main entry does not re-export, and
the local entry may import the client only through `../client/index.js` (`scripts/link-local-entry.mjs`: a second copy
breaks `instanceof` and the typings); until the sync lands (its `generate.sh` appends those exports to `index.ts`),
`src/local/generated.ts` reads the classes off a client whose `fetch` never leaves the process and types them through
`HaiAgentsClient`.

## Python commit tracked

hai-agents-python `b7e682c` (release 1.5.1), the commit `parity.json` pins. What moved since 1055153, the commit the
first port tracked, and where each change stands here:

Past the pin, Python's `main` has moved on; what is taken here and what waits for the pin to move: the runtime pin
0.1.31 (pinned here too, same digests); `SessionTimeoutError` and the session handle's cursor (landed on TS `main`
first, on record as `deferred` for `polling.py`); the `HAI_AGENT_LOCAL_BINARY_PATH`, `_BINARY_VERSION`, `_BASE_URL` and
`_CACHE_DIR` overrides and `HAI_AUTO_BRIDGE` removed (still read here: the env-var removal is a breaking change to take
with the pin); commands carrying `expires_at`, skipped once expired (bridge.py, transport.py: not ported yet); the
shell options `workspace` / `sandbox` on `create_session` (workstation only, decided out).

| Python change | Here |
| --- | --- |
| `openapi.json` syncs 6d8e45f, 317fa51, 1055153: tool approvals, environment and skill revisions | Landed on `main` with the platform's sync; `test_spec_defaults.py` 6ccae5a (`ToolApprovalResponseEvent`) ported here |
| `openapi.json` syncs befe7ee, 6eac539, 07eb688 (1.5.0, 1.5.1) | TS `main` has the same spec |
| `polling.py` 6ccae5a: `pending_approvals`, `approve` / `deny` | In the platform's overlay `polling.ts.static`; arrives with its client sync |
| `routing.py`, `desktop.py`, `workstation.py` e42271f, def07b1: desktops routed on mode, shell safety (policy, sandbox, CLI approvals) | Decided out: web only |
| `pin.json` 0b4ec40, 1f15df9, cb5fc3e: runtime 0.1.25, 0.1.28, 0.1.29 | `ts-local-launcher` pins what Python's `main` pins (same digests) |
| `install.py` def07b1: `install_artifact(name)` generalised for the workstation driver download; the insecure-URL error text loses the binary name | Error text ported; the generalisation is not (no workstation driver in TS) |
| `bridge.py`, `transport.py` 358f8fc: the platform's reason in local bridge errors | Ported on `ts-local` (`bridge.ts`, `transport.ts`) |
| `test_local.py` 4662a82 (desktop is always this machine), `test_cli.py` e68bb77 | Bridges and CLI: dropped rows above |

## Run it

```sh
pnpm test            # offline suite; the live tests are skipped unless HAI_API_KEY_TEST is set
pnpm typecheck
pnpm drift --check   # by hand, CI does not run it: exits 1 while a pair is pending (red on python-mirror by design)
pnpm drift --write   # regenerates the Ledger section above and PARITY.md
```

## `test_local.py` bridge protocol (branch `ts-local`: `local_bridge.test.ts`)

TestChannelSetup (5), TestBridgeProtocol (15), TestDriverInterfaces (11): 31 Python tests at b7e682c (the two
TestChannelSetup tests of 358f8fc, the platform's reason in bridge errors, and the seven workstation tests of
TestDriverInterfaces from e42271f / def07b1 included). Ported here: 17 (21 vitest cases:
the result-post 429 test keeps its two rows, the platform's-words test its four), all adapted the same way. Python drives the bridge through its private methods (`_open_channel`,
`_process_commands`, `_deliver`, `_poll_loop`) with a `FakeExchange`; the TS `LocalBridge` exposes
`start()`, `stop()` and `done`, so each test runs the real bridge against a fake command channel
(`FakeChannel`, the routes AGP serves) and asserts the same posted bodies; ids, command_uids, statuses
and messages are the Python ones.

### Expected failure

None. `test_undeliverable_result_raises_after_retries` was marked `it.fails` as a bridge gap; it was a gap in
the test's expectation. Python awaits `_deliver` alone and sees it raise after `POST_RESULT_RETRIES`; its poll
loop then backs off on the 5xx and keeps serving (bridge.py `_poll_loop`, `httpx.HTTPError` branch), as the TS
loop does. The TS test now reads the raise where the poll loop logs it, after `POST_RESULT_RETRIES + 1` posts
(3: the constant stays, Python's test patches it to 1).

### `browser.py` (`packages/sdk/src/local/browser.ts`, `PlaywrightBrowserBridge`)

Python's `SeleniumBrowserBridge` attaches Selenium to a Chrome remote-debugging port, launching Chrome from its
fixed install locations on `~/.hai/chrome-profile` when nothing listens. hai-drivers for Node has a Playwright
driver, not a Selenium one, so the TS bridge attaches Playwright over CDP to a Chrome on the port, or launches
Google Chrome (Playwright's `channel: "chrome"`) on the same profile; the launched one lives with the process and
is closed on `stop()`, where Python's is detached and reused on the port next time. Cut: `driver_interface` (the
command set lives in the TS driver). `environment_id` and `startup_hint` arrived with the routing layer (`ts-local`).
`hai-drivers` is not in the npm registry, so it is a runtime import with an install hint, not a declared peer;
`playwright-core` is an optional peer as `zod` is. Python has no unit test of the browser bridge beyond the
manager's routing (dropped rows below); `packages/sdk/tests/browser.test.ts` covers the TS composition with fakes.

### Dropped

| Python test | Reason |
| --- | --- |
| `TestBridgeProtocol::test_commands_come_from_the_driver_interface` | `CommandDriver` is `{ dispatch }`; the bridge has no command set |
| `TestBridgeProtocol::test_unknown_and_private_names_return_errors` | Unknown-name rejection lives in the driver (`hai_drivers/node` "refuses unknown commands"); private names have no TS concept |
| `TestBridgeProtocol::test_var_positional_args_are_splatted` | Python `*args` introspection; TS passes the args object verbatim |
| `TestDriverInterfaces::test_browser_commands_match_hai_drivers_interface` | Ported in `hai_drivers/node/tests/python-mirror/driver_interfaces.test.ts`, where `WEB_COMMAND_NAMES` lives |
| `TestDriverInterfaces::test_desktop_commands_match_hai_drivers_interface` | No desktop driver in TS |
| `TestDriverInterfaces::test_args_decode_by_the_interface_types` | No `deserialize_args`; desktop and workstation |
| `TestDriverInterfaces::test_workstation_serves_a_shell_in_its_session_folder_with_the_cli_commands` | No workstation bridge |
| `TestDriverInterfaces`: the seven workstation tests of e42271f / def07b1 (`test_workstation_holds_a_command_its_machine_does_not_allow_until_approved`, `..._starts_a_missing_allowlist_with_cua_and_keeps_an_existing_one`, `..._applies_what_the_agent_asks_and_what_the_machine_set_itself_wins`, `test_cua_runs_outside_the_sandbox_where_the_sandbox_cannot_open_its_daemon_alone`, `test_sandbox_rules_of_the_machine_s_own_confine_commands_where_confinement_is_not_the_default`, `test_workstation_confines_commands_with_srt_unless_the_machine_turns_it_off`, `..._built_in_rules_install_packages_and_keep_secrets_out_of_reach`) | No workstation bridge (shell safety: policy, sandbox, CLI approvals) |

## `test_local.py` auto bridges (branch `ts-local`: `local_sessions.test.ts`)

Web only, as the SDK: the TS routing layer serves one kind, the browser, so every Python test that spawns a
desktop or workstation bridge is adapted to the browser bridge (the contract is the same, the kind differs)
or dropped when the desktop is what it tests.

### TestLocalizeAgent: 21 Python tests, 14 ported

| Python test | TS test | What differs |
| --- | --- | --- |
| `test_unclaimed_user_device_envs_get_bridges_with_fresh_session_ids` | "unclaimed user device envs get bridges with fresh session ids" | Python's agent also carries a desktop environment served by a second bridge; one web environment here |
| `test_a_desktop_is_this_machine_and_its_mode_picks_the_bridge` | "a desktop is this machine and is refused without a desktop bridge" | Python picks the desktop or workstation bridge from the mode; TS refuses a desktop with the unsupported-kind error, both modes |
| `test_named_leaves_are_routed_by_override_unless_claimed` | same name | Python's `helper` subagent brings a shell desktop routed by a second override; a cloud browser here, so one override |
| `test_seed_makes_bridge_ids_reproducible_for_idempotent_retries`, `test_inline_subagents_are_walked` | same names | A browser environment where Python has a desktop |
| `test_bridge_mints_a_fresh_session_id`, `test_bridge_without_api_key_raises`, `test_bridge_rejects_non_uuid_session_id` | same names | `PlaywrightBrowserBridge` where Python builds a `PyautoguiDesktopBridge`; the checks live in the TS `LocalBridge` constructor as in Python's |
| `test_seeded_bridge_ids_are_scoped_to_the_caller` | same name | Python hands `_localize` a stand-in client wrapper (`_get_api_key`, `get_base_url`); the TS `_localize` reads the client options (`apiKey`, `baseUrl`) and is async, as the key is a Supplier |

Dropped:

| Python test | Reason |
| --- | --- |
| `test_a_shell_desktop_caps_its_cli_screenshots_at_the_spec_width`, `test_a_shell_desktop_brings_what_its_mode_asks_of_the_machine`, `test_a_shell_desktop_works_in_the_folder_this_machine_names` | Workstation bridge options |
| `test_pydantic_env_model_is_stamped`, `test_bare_env_model_gets_its_bridge_and_kind_tag` | The generated TS environments are plain objects that always carry `kind`; the plain-object case is the first test |
| `test_desktop_screenshots_are_scaled_at_the_source`, `test_desktop_bridge_with_all_knobs_off_serves_the_raw_driver` | Desktop driver composition |

### TestManager: 11 Python tests (10 in the class, `test_manager_reports_unconfirmed_stop_and_allows_retry` at module level), 10 ported

Python drives the manager with `ServingBridge` fakes (a `LocalBridge` subclass whose `run()` sets `ready` and waits)
and reads `runner.thread.is_alive()`; the TS fakes implement `ManagedBridge` (`start()` sets `ready`, `done` resolves on
`stop()`) and read `runner.alive`. The fakes keep Python's kinds (`desktop` for `ServingBridge`, `web` for the browser
one): the manager only compares the strings. `test_restarted_bridge_serves_again_on_a_fresh_loop` and
`test_closed_channel_is_a_clean_stop` run the real `LocalBridge` against an HTTP channel that answers 204, or 410 on the
path under test, where Python patches the exchange class and `httpx.AsyncClient`.

| Python test | What differs |
| --- | --- |
| `test_readiness_timeout_raises`, `test_manager_reports_unconfirmed_stop_and_allows_retry` | Python patches `READY_TIMEOUT_S` / `STOP_JOIN_TIMEOUT_S` down; a TS module constant cannot be patched, so the test fakes the clock (`vi.useFakeTimers`) and advances it past the constant |
| `test_startup_failure_surfaces_to_caller_without_firing_on_crash` | `exc_info.value.__cause__` is `error.cause` |
| `test_closed_channel_is_a_clean_stop` | `caplog` has no ERROR record: a `console.error` spy is never called |

Dropped: `test_one_process_drives_the_desktop` (the desktop lock).

### TestAutoStart: 13 Python tests, 10 ported

Python patches `hai_agents_local.sessions.ensure_bridges` / `stop_bridges` / `serving_bridges` and the generated
`SessionsClient` methods on the class; the TS tests patch the process-wide manager behind the first three
(`_defaultManager.ensure` / `stop` / `serving`) and `SessionsClient.prototype`. A patched generated method returns
the `HttpResponsePromise` the client awaits with `.withRawResponse()` (`reply()`), where Python's fakes return a
plain value. Every agent of these tests carries a desktop and a web environment; web only here, so each keeps the
web one (`_TWO_ENV_AGENT` has one bridge, and "stops sibling bridges" stops that one). The budget test compares the
request to the exported `DEFAULT_LOCAL_MAX_STEPS` / `DEFAULT_LOCAL_MAX_TIME_S` by design, as Python's does
(`test_local.py:498-508`): a changed value is caught by `pnpm drift --check`, which compares the constants to Python's.

| Python test | What differs |
| --- | --- |
| `test_create_session_starts_bridges_and_stamps_matching_session_ids` | The parent's desktop becomes a cloud browser; one bridge, the child's |
| `test_named_agent_routes_its_user_device_env_through_an_override` | The catalog agent's desktop is a `user_device` browser; the override key is `agent.environments[kind=web].session_id` |
| `test_follow_up_to_a_stopped_session_serves_its_bridges_again` | `["start", ["web"]]` where Python restarts `["desktop"]` |
| `test_bridge_loss_cancels_session_once_and_stops_sibling_bridges` | One bridge: its `onCrash` fires twice, the session is cancelled once |
| `test_crash_between_startup_and_session_creation_still_cancels` | `onCrash` is async (cancelling is an HTTP call); the fake create fires it without awaiting, as Python's sync handler ran inline |

Dropped:

| Python test | Reason |
| --- | --- |
| `test_async_crash_before_session_creation_cancels_off_the_loop` | One client in TS, the async one; the sync variant above covers it |
| `test_kill_switch_stops_bridges_then_cancels_local_sessions_even_if_a_bridge_hangs`, `test_stop_filed_during_session_creation_cancels_the_new_session` | The kill switch |

### Module-level stop tests: 5 Python tests (sync and async rows), 4 ported

`test_exit_retry_outlives_only_an_unconfirmed_cancel`, `test_close_cancels_only_sessions_still_served`,
`test_cancel_reaches_api_when_local_stop_cannot_be_confirmed`, `test_terminal_status_read_stops_the_session_bridges`:
the sync row of each (TS has one client). `test_close_cancels_only_sessions_still_served` hands the client a `fetch`
that answers 204, or 404 for the evicted session, where Python hands `httpx.MockTransport`. Dropped:
`test_stopping_workstation_interrupts_running_command_and_skips_queue` (workstation).

### `doctor`: not ported

`doctor` is the CLI's, whole: `hai_agents_cli/doctor.py` (`holo doctor`) holds its five checks (login, platform access,
the runtime binary, the browser driver, the desktop driver and its macOS grants) on top of `hai_agents_common.credentials`,
and nothing under `hai_agents_local` references it. `TestDoctor` tests `run_checks` there, so it falls under the CLI rows
above; the web-only checks (the runtime binary, a Chromium Playwright can launch) would be a TS-only addition, not a port.
