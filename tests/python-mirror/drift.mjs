#!/usr/bin/env node
// Python -> TypeScript drift detector. AGENTS.md says a TS file mirrors its Python counterpart
// (same names camelCased, same constants, same error texts) and a mirror test keeps its
// `def test_` name; this script checks that mechanically, the way hai's python-contract.test.ts
// reads the Python web interface in place. parity.json maps each Python module and test file to
// its TS mirror(s); parity-exceptions.json lists every difference with its reason. Anything
// else is DRIFT. Regexes on line starts, as in the hai precedent: enough for these files.
//
//   node drift.mjs            markdown report on stdout
//   node drift.mjs --write    also regenerates PORT.md between the drift markers (the per-file counts,
//                             the pending pairs and the open DRIFT list) and PARITY.md (every difference on record)
//   node drift.mjs --check    exits 1 on DRIFT, a stale exception or anything pending (by hand; CI does not run it)
//
// Rules, so the report reads the same for everyone:
// - reference: parity.json pins the hai-agents-python commit (`pin`); the sibling checkout (`python`, or
//   HAI_AGENTS_PYTHON) must be at that commit or the run stops and says how to check it out.
// - scope: every `.py` file under the directories of parity.json's `scope` (`__init__.py` and `conftest.py`
//   excluded: the test helpers are setup.ts + helpers.ts) must be a pair of parity.json, mapped or with a reason,
//   or the run stops; an entry ending in `/` covers a directory. The hand-written files of the generated
//   `hai_agents` package are listed one by one.
// - names: every Python module-level def / class / UPPER_CASE constant must exist in the TS
//   mirror (underscore-prefixed ones are flagged private but checked too); every exported TS
//   function / class / const must exist in Python. TS types and interfaces are a TS idiom, and
//   unexported TS helpers an implementation detail: neither is checked against Python.
// - constants: a numeric or string literal compared by value (the literal is read before a trailing comment,
//   so a URL's `//` is kept); a Python `_S` constant may be a TS `_MS` one, a thousand times larger (Node
//   times in milliseconds).
// - errors: the first string literal inside `raise X(...)` and `throw new X(...)`, placeholders
//   `{x}` / `${x}` normalised to `*` (`{x!r}` to `'*'`), compared both ways.
// - tests: `def test_a_b` is `it("a b")`; `[...]` suffixes, `%s` and `$var` of it.each rows are
//   dropped. A TS-only test is an addition (a candidate to upstream), listed, not DRIFT. An `it.skip`,
//   `it.todo` or `it.skipIf(true)` is not ported: its Python name reads as missing (DRIFT); `it.fails` runs, so
//   it is. A test under `describe.skipIf(...)` / `it.skipIf(...)` runs only when its condition allows (the live
//   suite): the ledger counts it under skipIf, not under Ported.
// - pending: a mapped TS file that is not in place is a GAP, not a crash. A file waiting in `pending/` beside its
//   mapped path (a test whose subject a later branch of the stack brings; that branch `git mv`s it into place) is
//   compared all the same, so the spec is checked; a pair with a file in neither place is not compared and its
//   exceptions wait with it, never stale. An exception about code a later branch adds to a file already in place
//   names a file of that branch in `landsWith` and waits the same way. A pair whose TS files are in place but
//   still the generator's output (the platform's overlays are not synced yet) says so in its own `landsWith`
//   (a note, not a path) and is not compared until the note is removed. The ledger counts a Python test ported
//   by a file in `pending/` under Pending, not under Ported. `--check` fails while any gap or waiting exception
//   remains: red by design until the stack is in.
//
// Limits (what the regexes cannot see, so it is on record by hand or not at all):
// - class members: a method, an option field or an attribute on either side is invisible; a TS one
//   ahead of Python is a `kind: "addition"` entry, a Python one is not caught.
// - a Python module variable counts only when UPPER_CASE (`_exit_cancels` is not seen), and a
//   constant whose value is not a number or string literal is matched by name alone.
// - placeholders normalise to `*`, so two messages that differ only inside one read as the same.
// - additions: what TS has ahead of Python by decision and the regexes cannot see (an option field, a
//   method, a rule) is on record as `kind: "addition"` with the reason `ts-ahead`: never DRIFT, never
//   stale, listed in PARITY.md as the Python follow-ups.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REASONS = ["node-forced", "ts-idiom", "decided-out", "deferred", "python-only-feature", "ts-ahead"];
const KINDS = ["name", "ts-name", "const", "error", "ts-error", "test", "addition"];
const here = dirname(fileURLToPath(import.meta.url));

/** Where a mapped TS file waits until the branch that brings its subject moves it into place. */
const pendingPath = (path) => join(dirname(path), "pending", basename(path));

// ---------- parsing ----------

const STRING = /f?(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|\$\{[^}]*\}|\$(?!\{)|[^`\\$])*)`)/g;

/** The index just past the string literal that starts at `i`, or `i` when none starts there. */
function skipString(text, i) {
  const quote = /^("""|\'\'\'|["'`])/.exec(text.slice(i, i + 3));
  if (!quote) return i;
  const close = text.indexOf(quote[1], i + quote[1].length);
  return close < 0 ? text.length : close + quote[1].length;
}

/** The text between the bracket at `open` and its match (the bracket excluded); strings are skipped. */
function balanced(src, open) {
  const pair = { "(": ")", "[": "]", "{": "}" };
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const past = skipString(src, i);
    if (past > i) i = past - 1;
    else if (src[i] === src[open]) depth += 1;
    else if (src[i] === pair[src[open]]) depth -= 1;
    if (depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** The literal value of a constant's right-hand side: a number, a string, or undefined. */
function literal(rhs) {
  // The quoted literal first, so a `//` or `#` inside it (a URL) is not read as a comment.
  const string = /^\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1\s*;?\s*(?:(?:#|\/\/).*)?$/.exec(rhs);
  if (string) return string[2];
  const text = rhs.replace(/\s*(#|\/\/).*$/, "").replace(/;$/, "").trim();
  if (/^-?\d[\d_]*(\.\d+)?$/.test(text)) return Number(text.replace(/_/g, ""));
  return undefined;
}

/** The message of a raise / throw: the string literals of its first argument that has one, joined. */
function message(args) {
  const first = splitTop(args).find((arg) => new RegExp(STRING.source).test(arg)) ?? "";
  const parts = [];
  let last = 0;
  for (const m of first.matchAll(STRING)) {
    const gap = first.slice(last, m.index).trim();
    if (parts.length && gap && gap !== "+") {
      if (!/^\+.*\+$/s.test(gap)) break;
      parts.push("*");
    }
    parts.push(m.slice(1).find((part) => part !== undefined));
    last = m.index + m[0].length;
  }
  if (!parts.length) return undefined;
  if (first.slice(last).trim().startsWith("+")) parts.push("*");
  return parts
    .join("")
    .replace(/\{\{/g, "{")
    .replace(/\{[^{}]*!r\}/g, "'*'")
    .replace(/\$\{[^}]*\}|\{[^{}]*\}/g, "*")
    .replace(/(['"`]|\\`)\*\1/g, "*")
    .replace(/\*+/g, "*")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split on the commas outside brackets and string literals, as hai's splitParams. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const past = skipString(text, i);
    if (past > i) i = past - 1;
    else if ("([{".includes(text[i])) depth += 1;
    else if (")]}".includes(text[i])) depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function raised(src, pattern) {
  const out = [];
  for (const m of src.matchAll(pattern)) {
    const text = message(balanced(src, m.index + m[0].length - 1));
    if (text) out.push({ cls: m[1], message: text });
  }
  return out;
}

export function parsePython(src) {
  const names = [];
  for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)/gm)) names.push({ name: m[1], kind: "def" });
  for (const m of src.matchAll(/^class\s+(\w+)/gm)) names.push({ name: m[1], kind: "class" });
  for (const m of src.matchAll(/^(_?[A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=(.*)$/gm)) {
    names.push({ name: m[1], kind: "const", value: literal(m[2]) });
  }
  for (const entry of names) entry.private = entry.name.startsWith("_");
  const errors = raised(src, /\braise[ \t]+([\w.]+)\(/g);
  const tests = [...src.matchAll(/^\s*(?:async\s+)?def\s+test_(\w+)/gm)].map((m) => m[1].replace(/_/g, " "));
  return { names, errors, tests };
}

export function parseTs(src) {
  const names = [];
  const decl = /^(export\s+)?(?:async\s+)?(?:abstract\s+)?(function|class|const|let|type|interface)\s+(\w+)(.*)$/gm;
  for (const m of src.matchAll(decl)) {
    const kind = m[2] === "let" ? "const" : m[2];
    const value = kind === "const" ? literal(/^\s*(?::[^=]*)?=(.*)$/.exec(m[4])?.[1] ?? "") : undefined;
    names.push({ name: m[3], kind, exported: Boolean(m[1]), value });
  }
  const errors = raised(src, /\bthrow\s+new\s+([\w.]+)\(/g);
  // The spans of `describe.skipIf(c)(...)` / `describe.runIf(c)(...)` blocks: the tests inside run on a condition.
  const conditionalSpans = [];
  for (const m of src.matchAll(/^\s*describe\.(?:skipIf|runIf)\(/gm)) {
    const at = m.index + m[0].length - 1 + balanced(src, m.index + m[0].length - 1).length + 2;
    conditionalSpans.push([at, at + balanced(src, at).length]);
  }
  const tests = [];
  const conditional = new Set();
  for (const m of src.matchAll(/^\s*(?:it|test)((?:\.\w+)*)(?:<.*>)?\(/gm)) {
    if (/\.(skip|todo)(?:\.|$)/.test(m[1])) continue; // a skipped or todo test is not ported: its Python name reads as missing, DRIFT
    let at = m.index + m[0].length - 1; // the "(" of the call; it.each(rows)(name) and it.skipIf(c)(name) have one more
    let isConditional = conditionalSpans.some(([start, end]) => m.index > start && m.index < end);
    if (/\.(each|skipIf|runIf)$/.test(m[1])) {
      const args = balanced(src, at);
      if (/\.skipIf$/.test(m[1]) && args.trim() === "true") continue; // it.skipIf(true) is it.skip
      if (/\.(skipIf|runIf)$/.test(m[1])) isConditional = true;
      at += args.length + 2;
    }
    const name = /^\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(balanced(src, at));
    if (!name) continue;
    const text = name[2].replace(/\s*\[.*$/, "").replace(/%[sdijo]|\$\w+/g, "").replace(/\s+/g, " ").trim();
    tests.push(text);
    if (isConditional) conditional.add(text);
  }
  return { names, errors, tests, conditional };
}

// ---------- comparing ----------

const camel = (name) => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
/** The TS spellings a Python name may take: `get_key` is `getKey`; `_helper` may drop its underscore. */
function spellings(name) {
  const bare = name.replace(/^_+/, "");
  return new Set([name, camel(name), bare, camel(bare), `_${camel(bare)}`]);
}

/** Every difference of one pair, before exceptions: names, constants and errors of a module, test names of a test file. */
export function comparePair(py, ts, group = "modules") {
  const findings = [];
  if (group === "modules") {
    const tsByName = new Map(ts.names.map((n) => [n.name, n]));
    const pyNames = new Set(py.names.map((n) => n.name));
    // Python keeps a sync and an async twin of a function or class; Node has the one async path.
    const twin = (name) => name.replace(/^(_?)async_/, "$1").replace(/_async$/, "").replace(/Async/, "");
    for (const entry of py.names) {
      if (twin(entry.name) !== entry.name && pyNames.has(twin(entry.name))) continue;
      const match = [...spellings(entry.name)].map((s) => tsByName.get(s)).find(Boolean);
      const ms = entry.kind === "const" && /_S$/.test(entry.name) && tsByName.get(entry.name.replace(/_S$/, "_MS"));
      if (!match && !ms) findings.push({ kind: "name", name: entry.name, detail: entry.private ? "private" : entry.kind });
      else if (entry.value !== undefined && match?.value !== undefined && match.value !== entry.value) {
        findings.push({ kind: "const", name: entry.name, detail: `python ${JSON.stringify(entry.value)}, ts ${JSON.stringify(match.value)}` });
      } else if (!match && ms && typeof entry.value === "number" && ms.value !== undefined && ms.value !== entry.value * 1000) {
        findings.push({ kind: "const", name: entry.name, detail: `python ${entry.value}s, ts ${ms.name} ${ms.value}` });
      }
    }
    const pySpellings = new Set(py.names.flatMap((n) => [...spellings(n.name), n.name.replace(/_S$/, "_MS")]));
    for (const entry of ts.names) {
      if (entry.exported && !["type", "interface"].includes(entry.kind) && !pySpellings.has(entry.name)) {
        findings.push({ kind: "ts-name", name: entry.name, detail: entry.kind });
      }
    }
    const tsErrors = new Set(ts.errors.map((e) => e.message));
    const pyErrors = new Set(py.errors.map((e) => e.message));
    for (const e of py.errors) if (!tsErrors.has(e.message)) findings.push({ kind: "error", name: e.message, detail: e.cls });
    for (const e of ts.errors) if (!pyErrors.has(e.message)) findings.push({ kind: "ts-error", name: e.message, detail: e.cls });
  }
  const tsTests = new Set(ts.tests);
  const pyTests = new Set(py.tests);
  for (const t of py.tests) if (!tsTests.has(t)) findings.push({ kind: "test", name: t });
  const tsOnly = ts.tests.filter((t) => !pyTests.has(t));
  const seen = new Set();
  return { findings: findings.filter((f) => !seen.has(`${f.kind}|${f.name}`) && seen.add(`${f.kind}|${f.name}`)), tsOnly };
}

/** Apply the exceptions of one pair: each finding is excepted or DRIFT; an adapted test (`ts`) leaves the TS-only list; an addition is on record as is. */
export function applyExceptions(pair, result, exceptions) {
  const used = new Set();
  const drift = [];
  const excepted = [];
  for (const rule of exceptions.filter((x) => x.pair === pair && x.kind === "addition")) {
    used.add(rule);
    excepted.push({ kind: "addition", name: rule.name, rule });
  }
  for (const finding of result.findings) {
    const rule = exceptions.find((x) => x.pair === pair && x.kind === finding.kind && x.name === finding.name);
    if (!rule) drift.push(finding);
    else {
      used.add(rule);
      excepted.push({ ...finding, rule });
      if (rule.ts) result.tsOnly = result.tsOnly.filter((t) => t !== rule.ts);
    }
  }
  const stale = exceptions.filter((x) => x.pair === pair && !used.has(x)).map((x) => `${x.kind} ${JSON.stringify(x.name)}`);
  for (const x of excepted) if (x.rule.ts && !(result.tsTests ?? new Set()).has(x.rule.ts)) stale.push(`adapted ${JSON.stringify(x.rule.ts)} is not a TS test`);
  return { drift, excepted, stale, tsOnly: result.tsOnly, pending: result.pending ?? new Set(), conditional: result.conditional ?? new Set() };
}

// ---------- running ----------

/** Every `.py` file under `dir` (recursively), as paths relative to `root`; `__init__.py` and `conftest.py` excluded. */
function pythonFiles(root, dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir)).sort()) {
    const relative = dir === "." ? entry : `${dir}/${entry}`;
    if (statSync(join(root, relative)).isDirectory()) {
      if (entry !== "__pycache__") out.push(...pythonFiles(root, relative));
    } else if (entry.endsWith(".py") && entry !== "__init__.py" && entry !== "conftest.py") out.push(relative);
  }
  return out;
}

/** The commit the Python checkout is at, or what `git` said instead. */
function head(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `? (${String(error.stderr ?? error.message).trim()})`;
  }
}

/** @param {{ root?: string, pythonRoot?: string, parity?: any, exceptions?: any[] }} [options] */
export function run({ root = resolve(here, "../.."), pythonRoot, parity, exceptions } = {}) {
  parity ??= JSON.parse(readFileSync(join(here, "parity.json"), "utf-8"));
  exceptions ??= JSON.parse(readFileSync(join(here, "parity-exceptions.json"), "utf-8"));
  pythonRoot ??= process.env.HAI_AGENTS_PYTHON ?? resolve(root, parity.python);
  if (parity.pin) {
    const at = head(pythonRoot);
    if (at !== parity.pin) {
      throw new Error(
        `hai-agents-python at ${pythonRoot} is at ${at}; parity.json pins ${parity.pin}. Check it out there: git -C ${pythonRoot} fetch && git -C ${pythonRoot} checkout ${parity.pin}`,
      );
    }
  }
  const pairs = parity.modules.concat(parity.tests);
  if (parity.scope) {
    const covered = (file) => pairs.some((p) => [].concat(p.python).some((q) => (q.endsWith("/") ? file.startsWith(q) : q === file)));
    const missing = parity.scope.flatMap((dir) => pythonFiles(pythonRoot, dir)).filter((file) => !covered(file));
    if (missing.length) throw new Error(`parity.json: Python files in scope with no entry (map each or give it a reason):\n${missing.map((f) => `  ${f}`).join("\n")}`);
  }
  for (const x of exceptions) {
    if (!REASONS.includes(x.reason) || !KINDS.includes(x.kind)) throw new Error(`parity-exceptions.json: bad entry ${JSON.stringify(x)}`);
    if ((x.kind === "addition") !== (x.reason === "ts-ahead")) throw new Error(`parity-exceptions.json: an addition is ts-ahead and ts-ahead is an addition: ${JSON.stringify(x)}`);
  }
  // An entry about code a later branch brings into a file already in place (`landsWith`: a file of that branch) waits with it.
  const waiting = exceptions.filter((x) => x.landsWith && !existsSync(join(root, x.landsWith)));
  exceptions = exceptions.filter((x) => !waiting.includes(x));
  for (const p of pairs) {
    if (!p.ts && !REASONS.includes(p.reason)) throw new Error(`parity.json: ${p.python} has no TS mirror and no reason`);
  }
  const rows = [];
  for (const group of ["modules", "tests"]) {
    for (const spec of parity[group]) {
      const pair = { ...spec, python: [].concat(spec.python).join(" + ") };
      const pyPaths = [].concat(spec.python);
      for (const p of pyPaths) {
        if (!existsSync(join(pythonRoot, p))) throw new Error(`missing ${join(pythonRoot, p)}: HAI_AGENTS_PYTHON names the hai-agents-python checkout`);
      }
      // An entry ending in "/" is a whole directory with one reason (the CLI); it has nothing to parse.
      const parsedPy = pyPaths.filter((p) => !p.endsWith("/")).map((p) => parsePython(readFileSync(join(pythonRoot, p), "utf-8")));
      const py = { names: parsedPy.flatMap((p) => p.names), errors: parsedPy.flatMap((p) => p.errors), tests: parsedPy.flatMap((p) => p.tests) };
      if (!pair.ts) {
        rows.push({ group, pair, py, dropped: true, drift: [], excepted: [], stale: [], tsOnly: [] });
        continue;
      }
      const files = pair.ts.map((p) => [p, pendingPath(p)].find((f) => existsSync(join(root, f))));
      const waiting = pair.ts.filter((p, i) => files[i] !== p);
      // A module pair whose files are in place but still the generator's output waits for the platform's sync (`landsWith`, a note).
      const unsynced = group === "modules" && pair.landsWith && !existsSync(join(root, pair.landsWith));
      if (files.includes(undefined) || unsynced) {
        const gap = { files: unsynced ? pair.ts : waiting, exceptions: exceptions.filter((x) => x.pair === pair.python).length, landsWith: pair.landsWith };
        rows.push({ group, pair, py, gap, drift: [], excepted: [], stale: [], tsOnly: [] });
        continue;
      }
      const parsed = files.map((f) => parseTs(readFileSync(join(root, f), "utf-8")));
      const ts = { names: parsed.flatMap((p) => p.names), errors: parsed.flatMap((p) => p.errors), tests: parsed.flatMap((p) => p.tests) };
      const compared = comparePair(py, ts, group);
      compared.tsTests = new Set(ts.tests);
      // Where each TS test sits: in a pending/ file, or under a skipIf condition (the first file that has it wins).
      compared.pending = new Set(parsed.flatMap((p, i) => (files[i] !== pair.ts[i] ? p.tests : [])).filter((t) => !parsed.some((p, i) => files[i] === pair.ts[i] && p.tests.includes(t))));
      compared.conditional = new Set(parsed.flatMap((p) => [...p.conditional]));
      const gap = waiting.length ? { files: waiting, tests: [...compared.pending].filter((t) => py.tests.includes(t)).length, landsWith: pair.landsWith } : undefined;
      rows.push({ group, pair, py, ts, gap, ...applyExceptions(pair.python, compared, exceptions) });
    }
  }
  const known = new Set(rows.map((r) => r.pair.python));
  const orphans = exceptions.filter((x) => !known.has(x.pair)).map((x) => `${x.pair} ${x.kind} ${JSON.stringify(x.name)}: pair not in parity.json`);
  return { rows, orphans, pythonRoot, waiting, pin: parity.pin };
}

const count = (kind, list) => list.filter((f) => f.kind === kind).length;
/** A pair's TS files for a table cell, each one not in place marked pending. */
const mirrors = (row, prefix) => row.pair.ts.map((p) => `\`${p.replace(prefix, "")}\`${row.gap?.files.includes(p) ? " (pending)" : ""}`).join(", ");
const cell = (row, kinds) => {
  if (row.dropped) return "";
  if (!row.ts) return "pending";
  const n = (list) => list.filter((f) => kinds.includes(f.kind)).length;
  const drift = n(row.drift);
  return `${n(row.excepted)} excepted${drift ? `, **${drift} DRIFT**` : ""}`;
};
const sha = (dir) => {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "?";
  }
};

/** The per-file counts: names, constants and errors of each module, test names of each test file. */
export function counts({ rows }) {
  const out = ["| Python module | TS mirror | Names | Constants | Errors |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows.filter((r) => r.group === "modules")) {
    const ts = row.dropped ? `none (${row.pair.reason}: ${row.pair.note})` : mirrors(row, "packages/sdk/src/");
    out.push(`| \`${row.pair.python.replaceAll("src/", "")}\` | ${ts} | ${cell(row, ["name", "ts-name"])} | ${cell(row, ["const"])} | ${cell(row, ["error", "ts-error"])} |`);
  }
  out.push(
    "",
    "| Python test file | TS mirror | `def test_` | Ported | Pending | skipIf | Adapted | Dropped | DRIFT | TS-only |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of rows.filter((r) => r.group === "tests")) {
    const total = row.py.tests.length;
    if (row.dropped) {
      out.push(`| \`${row.pair.python}\` | none (${row.pair.reason}: ${row.pair.note}) | ${total} | 0 | 0 | 0 | 0 | ${total} | 0 | 0 |`);
      continue;
    }
    const adapted = row.excepted.filter((f) => f.kind === "test" && f.rule.ts).length;
    const droppedN = row.excepted.filter((f) => f.kind === "test" && !f.rule.ts).length;
    const drift = count("test", row.drift);
    const ts = mirrors(row, "tests/python-mirror/");
    if (!row.ts) {
      out.push(`| \`${row.pair.python}\` | ${ts} | ${total} | pending | pending | pending | pending | pending | pending | pending |`);
      continue;
    }
    // A Python test ported by a pending/ file, or by a test under a skipIf condition, is not counted as ported.
    const accounted = new Set(row.drift.filter((f) => f.kind === "test").concat(row.excepted.filter((f) => f.kind === "test")).map((f) => f.name));
    const open = row.py.tests.filter((t) => !accounted.has(t));
    const pending = open.filter((t) => row.pending.has(t)).length;
    const conditional = open.filter((t) => !row.pending.has(t) && row.conditional.has(t)).length;
    out.push(
      `| \`${row.pair.python}\` | ${ts} | ${total} | ${open.length - pending - conditional} | ${pending} | ${conditional} | ${adapted} | ${droppedN} | ${drift ? `**${drift}**` : 0} | ${row.tsOnly.length} |`,
    );
  }
  return out.join("\n");
}

/** A markdown table cell: backslashes first, then the pipes. */
const escapeCell = (text) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

/** Every difference on record with its reason, one table per kind: the body of PARITY.md. */
export function record({ rows }) {
  const out = [];
  for (const [kind, title] of [["name", "Names"], ["const", "Constants"], ["error", "Error texts"], ["test", "Tests"], ["addition", "Additions (TS ahead of Python)"]]) {
    const kinds = ["test", "addition"].includes(kind) ? [kind] : [kind, `ts-${kind}`];
    const items = rows.flatMap((r) => (r.excepted ?? []).filter((f) => kinds.includes(f.kind)).map((f) => ({ pair: r.pair.python, ...f })));
    if (!items.length) continue;
    out.push(...(out.length ? [""] : []), `### ${title} on record`, "", "| Pair | Side | Name | Reason | Note |", "| --- | --- | --- | --- | --- |");
    for (const f of items) {
      const side = f.kind === "addition" || f.kind.startsWith("ts-") ? "TS only" : f.detail === "private" ? "Python (private)" : "Python";
      const name = f.rule.ts ? `\`${f.name}\` → \`${f.rule.ts}\`` : `\`${escapeCell(f.name)}\``;
      out.push(`| \`${f.pair}\` | ${side} | ${name} | ${f.rule.reason} | ${escapeCell(f.rule.note ?? "")} |`);
    }
  }
  return out.join("\n");
}

/** The counts, then the record: the report's tables. */
export function tables(result) {
  return `${counts(result)}\n\n${record(result)}`;
}

/** The open DRIFT, one line each. */
export function driftList({ rows }) {
  return rows.flatMap((r) => (r.drift ?? []).map((f) => `- \`${r.pair.python}\` ${f.kind} \`${f.name}\`${f.detail ? ` (${f.detail})` : ""}`));
}

/** What is not in place yet, one line each: a pair with a test file in pending/ (compared) or a file in neither place (not compared), an exception waiting for its file. */
export function pendingList({ rows, waiting }) {
  const exceptions = (waiting ?? []).map((x) => `- \`${x.pair}\` ${x.kind} ${JSON.stringify(x.name)}: lands with \`${x.landsWith}\``);
  const pairs = rows
    .filter((r) => r.gap)
    .map((r) => {
      const files = r.gap.files.map((f) => `\`${f}\``).join(", ");
      const what = r.ts
        ? `in pending/, compared (Python tests ported there: ${r.gap.tests})`
        : `${r.group === "modules" && r.gap.landsWith ? "in place, the generator's output, " : "not in place, "}not compared (Python ${r.group === "modules" ? `names: ${r.py.names.length}` : `tests: ${r.py.tests.length}`}, exceptions waiting: ${r.gap.exceptions})`;
      return `- \`${r.pair.python}\` → ${files}: ${what}${r.gap.landsWith ? `; lands with ${r.gap.landsWith}` : ""}`;
    });
  return pairs.concat(exceptions);
}

/** PORT.md's generated section: the counts, where the record is, the pending pairs, the open DRIFT. */
export function ledger(result) {
  const drift = driftList(result);
  const pending = pendingList(result);
  const where = "Every difference on record, with its reason, is in [PARITY.md](PARITY.md), generated with this section.";
  const section = (title, lines) => [`### ${title} (${lines.length})`, "", ...(lines.length ? lines : ["None."])];
  return [counts(result), "", where, "", ...section("Pending", pending), "", ...section("DRIFT", drift)].join("\n");
}

export function report(result, root) {
  const { rows, orphans, pythonRoot } = result;
  const out = [`# Python → TypeScript drift`, "", `hai-agents-python ${sha(pythonRoot)} (parity.json pins ${result.pin ?? "no commit"}), hai-agents-ts ${sha(root)}.`, "", tables(result)];
  const drift = driftList(result);
  const pending = pendingList(result);
  const stale = rows.flatMap((r) => (r.stale ?? []).map((s) => `- \`${r.pair.python}\` ${s}`)).concat(orphans.map((o) => `- ${o}`));
  const tsOnly = rows.flatMap((r) => (r.tsOnly ?? []).map((t) => `- \`${r.pair.ts.join("`, `")}\` "${t}"`));
  out.push("", `## Pending (${pending.length})`, "", ...(pending.length ? pending : ["None."]));
  out.push("", `## DRIFT (${drift.length})`, "", ...(drift.length ? drift : ["None."]));
  out.push("", `## Stale exceptions (${stale.length})`, "", ...(stale.length ? stale : ["None."]));
  out.push("", `## TS-only tests (${tsOnly.length}, candidates to upstream)`, "", ...(tsOnly.length ? tsOnly : ["None."]));
  return { text: out.join("\n") + "\n", failed: drift.length + stale.length + pending.length > 0 };
}

/** Replace what sits between the drift markers of PORT.md; the prose around them is hand-written. */
export function writePortMd(path, generated) {
  const text = readFileSync(path, "utf-8");
  const [begin, end] = ["<!-- drift:begin -->", "<!-- drift:end -->"];
  const [start, stop] = [text.indexOf(begin), text.indexOf(end)];
  if (start < 0 || stop < 0) throw new Error(`${path}: drift markers not found`);
  const stamp = `Generated by \`pnpm drift --write\`; edit parity.json / parity-exceptions.json, not this section.`;
  writeFileSync(path, `${text.slice(0, start + begin.length)}\n${stamp}\n\n${generated}\n${text.slice(stop)}`);
}

/** PARITY.md whole: a header saying it is generated, then the record. */
export function writeParityMd(path, generated) {
  const header = [
    "# Differences on record (generated)",
    "",
    "Generated by `pnpm drift --write` (`tests/python-mirror/drift.mjs`) from `parity.json` and `parity-exceptions.json`; edit those, not this file.",
    "Every difference between a Python module or test file and its TS mirror that is not DRIFT, with one of the six reasons of PORT.md's",
    "Decisions, and the additions TS carries ahead of Python (ts-ahead); PORT.md's Ledger holds the per-file counts and the open DRIFT list.",
  ].join("\n");
  writeFileSync(path, `${header}\n\n${generated}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(here, "../..");
  let result;
  try {
    result = run({ root });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  const { text, failed } = report(result, root);
  process.stdout.write(text);
  if (process.argv.includes("--write")) {
    writePortMd(join(here, "PORT.md"), ledger(result));
    writeParityMd(join(here, "PARITY.md"), record(result));
  }
  if (process.argv.includes("--check") && failed) process.exit(1);
}
