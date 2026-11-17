# hai-agents-ts

The TypeScript SDK for H Company's Agents API. It is a port of `hai-agents-python`; these
notes say what that means for anyone changing it.

## Mirroring hai-agents-python

The Python SDK is the reference. A TypeScript file mirrors its Python counterpart: same file
split, same names (camelCased), same constants, same error texts, same function order. Port,
do not redesign.

Two exceptions are allowed: Node forces a difference (no sync I/O in the loop, `fetch` instead
of httpx, one event loop), or a TypeScript idiom calls for one (a zod schema for a pydantic
model, `AsyncGenerator` for a generator). Every difference gets a one-line comment on the spot
saying what Python does and why this differs. No comment means "identical to Python".

The Python checkout is a sibling directory, `../hai-agents-python`
(github.com/hcompai/hai-agents-python). Read the Python file before writing the TypeScript one.

`tests/python-mirror` is the ported test suite and `tests/python-mirror/PORT.md` is the drift
ledger: every test that is dropped or adapted is listed there with the reason. A mirror test
keeps the name of its `def test_` source (`test_x_y` becomes `it("x y")`), so the two suites can
be diffed by name. TypeScript-only behaviour is tested in `packages/sdk/tests`, not in the mirror.

## Boundaries

`packages/sdk/src/client` is generated. The agent_platform repo (`sdk-codegen/ts`) runs Fern and
copies its `*.static` overlays over the output; the next sync wipes the directory. Never edit it
here: a change to `polling.ts`, `tools.ts`, `oo.ts`, the error classes or the fetcher goes to the
overlay in agent_platform, in a paired change.

`hai-agents/local` is the Node-only entry: it may spawn processes and read files. The main
entry (`hai-agents`) stays browser-safe: no `node:` import anywhere it reaches;
`packages/sdk/tests/browserBundle.test.ts` enforces it.

Local control is web only: a `LocalBridge` composed with the Playwright driver from `hai-drivers`.
No desktop, mobile or workstation driver, no bridge manager, kill switch or CLI: Python has
them, this repo does not.

Timing and retry constants (poll intervals, backoff, retry counts, request limits) are
decisions taken in Python. A port copies them; it does not tune them.

## Commits

Commit locally with conventional messages (`feat(sdk): ...`, `fix(sdk): ...`, `test(sdk): ...`,
`chore(sdk): ...`). No co-author trailers. Do not push and do not open a pull request unless
asked.
