// drift.mjs on a fixture pair: one planted difference of each kind, an adapted test, a stale exception.
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REASONS, applyExceptions, comparePair, counts, ledger, parsePython, parseTs, pendingList, record, report, run, writeParityMd, writePortMd } from "./drift.mjs";
import { tmpPath } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "drift");
const parity = {
  python: ".",
  modules: [
    { python: "mod.py", ts: ["mod.ts"] },
    { python: "cli/", ts: null, reason: "decided-out", note: "a whole directory" },
  ],
  tests: [
    { python: "test_mod.py", ts: ["mod.test.ts"] },
    { python: "test_mod.py", ts: null, reason: "decided-out", note: "a file with no mirror" },
  ],
};
const exceptions = [
  { pair: "mod.py", kind: "name", name: "_PRIVATE", reason: "ts-idiom", note: "inlined" },
  { pair: "test_mod.py", kind: "test", name: "renamed thing", reason: "ts-idiom", ts: "renamed thing in ts" },
  { pair: "test_mod.py", kind: "test", name: "dropped thing", reason: "decided-out" },
  { pair: "test_mod.py", kind: "test", name: "never existed", reason: "deferred" },
];
const names = (findings: { kind: string; name: string }[], kind: string) => findings.filter((f) => f.kind === kind).map((f) => f.name);

describe("the fixture pair", () => {
  const py = parsePython(readFileSync(path.join(fixtures, "mod.py"), "utf-8"));
  const ts = parseTs(readFileSync(path.join(fixtures, "mod.ts"), "utf-8"));
  const { findings } = comparePair(py, ts);

  it("matches camelCased names, private names without their underscore, _S constants as _MS, and skips async twins", () => {
    expect(names(findings, "name")).toEqual(["_PRIVATE"]);
    expect(names(findings, "ts-name")).toEqual(["extra"]); // Options is a type, helper is not exported
  });

  it("compares constants by value, a literal read before its trailing comment", () => {
    expect(findings.filter((f) => f.kind === "const")).toEqual([{ kind: "const", name: "NAME", detail: 'python "fixture", ts "other"' }]);
    expect(py.names.find((n) => n.name === "URL")?.value).toBe("https://x.example/y"); // the `//` of the URL is not a comment
    expect(ts.names.find((n) => n.name === "URL")?.value).toBe("https://x.example/y");
  });

  it("compares error texts with placeholders and quotes normalised, both ways", () => {
    expect(py.errors.map((e) => e.message)).toEqual(["x is required (got *)", "gone, said python"]);
    expect(names(findings, "error")).toEqual(["gone, said python"]);
    expect(names(findings, "ts-error")).toEqual(["vanished, said ts"]);
  });

  it("compares test names, it.each rows included, lists the TS-only ones, and reads a skipped, todo or skipIf(true) test as not ported", () => {
    const ts = parseTs(readFileSync(path.join(fixtures, "mod.test.ts"), "utf-8"));
    expect(ts.tests).toEqual(["one thing", "rows thing", "renamed thing in ts", "extra thing", "live thing"]);
    expect([...ts.conditional]).toEqual(["live thing"]); // under describe.skipIf: runs on a condition
    const tests = comparePair(parsePython(readFileSync(path.join(fixtures, "test_mod.py"), "utf-8")), ts, "tests");
    expect(names(tests.findings, "test")).toEqual(["renamed thing", "dropped thing", "skipped thing", "gone thing"]);
    expect(tests.tsOnly).toEqual(["renamed thing in ts", "extra thing"]);
  });
});

describe("the exceptions file", () => {
  it("excepts, adapts, and reports what is stale", () => {
    const result = run({ root: fixtures, pythonRoot: fixtures, parity, exceptions });
    const [mod, , tests, dropped] = result.rows; // the `cli/` row sits between
    expect(mod.drift.map((f) => `${f.kind} ${f.name}`)).toEqual(["const NAME", "ts-name extra", "error gone, said python", "ts-error vanished, said ts"]);
    expect(tests.drift).toEqual([{ kind: "test", name: "skipped thing" }, { kind: "test", name: "gone thing" }]); // it.skip and it.skipIf(true) are not ported
    expect(tests.tsOnly).toEqual(["extra thing"]); // the adapted test left the list
    expect(tests.stale).toEqual(['test "never existed"']);
    expect(dropped.dropped).toBe(true);
    const { text, failed } = report(result, fixtures);
    expect(failed).toBe(true);
    // 7 Python tests: 2 ported, 0 pending, 1 under skipIf, 1 adapted, 1 dropped, 2 DRIFT; 1 TS-only.
    expect(text).toContain("| `test_mod.py` | `mod.test.ts` | 7 | 2 | 0 | 1 | 1 | 1 | **2** | 1 |");
    expect(text).toContain("## DRIFT (6)");
  });

  it("refuses a Python checkout that is not at the pinned commit, and names the checkout command", () => {
    const pinned = { ...parity, pin: "0000000000000000000000000000000000000000" };
    expect(() => run({ root: fixtures, pythonRoot: fixtures, parity: pinned, exceptions })).toThrow(/parity\.json pins 0000000000000000000000000000000000000000\. Check it out there: git -C .* checkout 0000000000000000000000000000000000000000/);
  });

  it("refuses a Python file in scope that parity.json does not list, mapped or with a reason", () => {
    const scoped = { ...parity, scope: ["."] }; // cli/app.py is covered by the `cli/` entry
    expect(() => run({ root: fixtures, pythonRoot: fixtures, parity: scoped, exceptions })).not.toThrow();
    const partial = { ...scoped, tests: [], modules: [parity.modules[0]] };
    expect(() => run({ root: fixtures, pythonRoot: fixtures, parity: partial, exceptions })).toThrow(/no entry[\s\S]*cli\/app\.py\n  test_mod\.py/);
  });

  it("escapes backslashes and pipes in the record's cells", () => {
    const odd = [{ pair: "mod.py", kind: "name", name: "_PRIVATE", reason: "ts-idiom", note: "a\\b|c" }];
    const result = run({ root: fixtures, pythonRoot: fixtures, parity, exceptions: odd });
    expect(record(result)).toContain("| `mod.py` | Python (private) | `_PRIVATE` | ts-idiom | a\\\\b\\|c |");
  });

  it("keeps the per-file counts and the open DRIFT in the ledger, and the record apart", () => {
    const result = run({ root: fixtures, pythonRoot: fixtures, parity, exceptions });
    const row = "| `test_mod.py` | `mod.test.ts` | 7 | 2 | 0 | 1 | 1 | 1 | **2** | 1 |";
    expect(counts(result)).toContain(row);
    expect(counts(result)).not.toContain("### Names on record");
    expect(record(result)).toContain("### Names on record");
    expect(record(result)).toContain("| `test_mod.py` | Python | `renamed thing` → `renamed thing in ts` | ts-idiom |");
    expect(record(result)).not.toContain(row);
    expect(ledger(result)).toContain(row);
    expect(ledger(result)).toContain("[PARITY.md](PARITY.md)");
    expect(ledger(result)).toContain("### DRIFT (6)\n\n- `mod.py` const `NAME`");
    expect(ledger(result)).not.toContain("### Names on record");
  });

  it("refuses a reason outside the six", () => {
    expect(REASONS).toHaveLength(6);
    const bad = [{ pair: "mod.py", kind: "name", name: "_PRIVATE", reason: "because" }];
    expect(() => run({ root: fixtures, pythonRoot: fixtures, parity, exceptions: bad })).toThrow("bad entry");
  });

  it("puts an addition on record without a finding, never stale, and ties it to ts-ahead", () => {
    const addition = { pair: "mod.py", kind: "addition", name: "Options.extra", reason: "ts-ahead", note: "TS only, by decision" };
    const result = run({ root: fixtures, pythonRoot: fixtures, parity, exceptions: [...exceptions, addition] });
    const [mod] = result.rows;
    expect(mod.stale).toEqual([]);
    expect(mod.excepted.filter((f) => f.kind === "addition").map((f) => f.name)).toEqual(["Options.extra"]);
    expect(record(result)).toContain("### Additions (TS ahead of Python) on record");
    expect(record(result)).toContain("| `mod.py` | TS only | `Options.extra` | ts-ahead | TS only, by decision |");
    expect(counts(result)).not.toContain("Options.extra");
    const mismatched = [{ ...addition, reason: "ts-idiom" }, { pair: "mod.py", kind: "name", name: "_PRIVATE", reason: "ts-ahead" }];
    for (const bad of mismatched) expect(() => run({ root: fixtures, pythonRoot: fixtures, parity, exceptions: [bad] })).toThrow("an addition is ts-ahead");
  });

  it("reads what is not in place as pending: a test file in pending/ is compared, a missing module and a landsWith exception wait", () => {
    const pending = {
      python: ".",
      modules: [{ python: "mod.py", ts: ["absent.ts"] }],
      tests: [{ python: "test_mod.py", ts: ["mod.test.ts", "waiting.test.ts"] }],
    };
    const later = { pair: "test_mod.py", kind: "test", name: "brought later", reason: "deferred", landsWith: "absent.ts" };
    const result = run({ root: fixtures, pythonRoot: fixtures, parity: pending, exceptions: [...exceptions, later] });
    const [mod, tests] = result.rows;
    expect(mod.gap).toEqual({ files: ["absent.ts"], exceptions: 1, landsWith: undefined });
    expect(mod.stale).toEqual([]); // _PRIVATE waits with its module
    expect(tests.gap).toEqual({ files: ["waiting.test.ts"], tests: 1, landsWith: undefined });
    expect(tests.drift).toEqual([{ kind: "test", name: "gone thing" }]); // pending/waiting.test.ts ports the test mod.test.ts skips
    expect(tests.stale).toEqual(['test "never existed"']); // compared all the same; "brought later" waits for absent.ts
    expect(pendingList(result)).toEqual([
      "- `mod.py` → `absent.ts`: not in place, not compared (Python names: 9, exceptions waiting: 1)",
      "- `test_mod.py` → `waiting.test.ts`: in pending/, compared (Python tests ported there: 1)",
      '- `test_mod.py` test "brought later": lands with `absent.ts`',
    ]);
    expect(counts(result)).toContain("| `mod.py` | `absent.ts` (pending) | pending | pending | pending |");
    // The test pending/waiting.test.ts ports is counted under Pending, not Ported.
    expect(counts(result)).toContain("| `test_mod.py` | `mod.test.ts`, `waiting.test.ts` (pending) | 7 | 2 | 1 | 1 | 1 | 1 | **1** | 1 |");
    expect(ledger(result)).toContain("### Pending (3)\n\n- `mod.py` → `absent.ts`");
    const { text, failed } = report(result, fixtures);
    expect(text).toContain("## Pending (3)");
    expect(failed).toBe(true); // --check stays red while a pair is pending
  });

  it("reads a module pair that waits for the platform's sync (landsWith a note) as pending, in place but not compared", () => {
    const unsynced = { ...parity, modules: [{ python: "mod.py", ts: ["mod.ts"], landsWith: "the platform's client sync" }] };
    const result = run({ root: fixtures, pythonRoot: fixtures, parity: unsynced, exceptions });
    const [mod] = result.rows;
    expect(mod.drift).toEqual([]);
    expect(mod.gap).toEqual({ files: ["mod.ts"], exceptions: 1, landsWith: "the platform's client sync" });
    expect(pendingList(result)[0]).toBe(
      "- `mod.py` → `mod.ts`: in place, the generator's output, not compared (Python names: 9, exceptions waiting: 1); lands with the platform's client sync",
    );
    expect(counts(result)).toContain("| `mod.py` | `mod.ts` (pending) | pending | pending | pending |");
    expect(report(result, fixtures).failed).toBe(true);
  });

  it("writes between the PORT.md markers only", () => {
    const file = path.join(tmpPath(), "PORT.md");
    writeFileSync(file, "# Hand-written\n\n<!-- drift:begin -->\nold tables\n<!-- drift:end -->\n\nMore prose.\n");
    writePortMd(file, "| new |");
    const written = readFileSync(file, "utf-8");
    expect(written.startsWith("# Hand-written\n\n<!-- drift:begin -->\nGenerated by")).toBe(true);
    expect(written.endsWith("| new |\n<!-- drift:end -->\n\nMore prose.\n")).toBe(true);
    expect(written).not.toContain("old tables");
    expect(applyExceptions).toBeTypeOf("function");
  });

  it("writes PARITY.md whole, under a header that says it is generated", () => {
    const file = path.join(tmpPath(), "PARITY.md");
    writeParityMd(file, "| new |");
    const written = readFileSync(file, "utf-8");
    expect(written.startsWith("# Differences on record (generated)\n\nGenerated by `pnpm drift --write`")).toBe(true);
    expect(written.endsWith("\n\n| new |\n")).toBe(true);
  });
});
