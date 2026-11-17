# tests/python-mirror

A one-to-one TypeScript port of the `hai-agents-python` test suite (`tests/` in that repo), written with
[vitest](https://vitest.dev) and run against the SDK sources in `packages/sdk/src` of this checkout. It is
its own pnpm workspace package, so `pnpm -r run test` at the root runs it alongside `packages/sdk`'s own
tests without either suite seeing the other's files.

Only Python tests with a TypeScript primitive are ported. The CLI and its credentials store, the MCP server
install, the desktop and workstation bridges and the kill switch have no counterpart in `hai-agents-ts`, so their
tests are not here; `PORT.md` is the ledger of what is dropped or adapted, and why.

| Python                          | TypeScript                         |
| ------------------------------- | ---------------------------------- |
| `conftest.py`                   | `setup.ts` + `helpers.ts`          |
| `test_<name>.py`                | `<name>.test.ts` (`test_local.py`: `local_bridge.test.ts` and `local_sessions.test.ts`; `parity.json` lists every split) |
| `integration/conftest.py`       | `integration/fixtures.ts`          |
| `integration/test_<name>.py`    | `integration/<name>.test.ts`       |
| `pytest.fixture`                | `beforeEach` / helper function     |
| `monkeypatch`                   | `mp` (`helpers.ts`)                |
| `tmp_path`                      | `tmpPath()`                        |
| `pytest.raises(T, match=...)`   | `raises(fn, T, match)` / `raisesAsync` |
| `pytest.mark.parametrize`       | `it.each(...)`                     |
| `pytest.mark.skipif`            | `it.skipIf(...)` / `describe.skipIf(...)` |
| `pydantic.BaseModel`            | `zod` schema                       |

```sh
pnpm install             # from the repo root (pnpm test and pnpm typecheck also work there)
pnpm test                # offline suite
pnpm test:integration    # live suite; skipped unless HAI_API_KEY_TEST is set
pnpm typecheck
pnpm drift                # Python -> TS drift report (PORT.md: Ledger); --check fails on DRIFT or a pending pair, --write refreshes PORT.md's Ledger and PARITY.md
```

`pending/` holds the tests whose subject a later branch of the stack brings (the launcher's on `python-mirror`, the
bridges' until `ts-local`): vitest and the typecheck skip it, drift still compares it, and `pnpm drift --check` stays
red until the branch that brings the subject moves them into place with `git mv`. `packages/sdk/tests/pending/` does
the same for the TS-only tests.
