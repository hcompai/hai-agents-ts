// Release helpers: `current` prints the SDK version, `bump` raises its patch in every file
// that stamps it, `changed <ref>` tells whether the published package changed since <ref>,
// `check` fails when the API spec needs an operation prod does not serve, or (with --runtime-pin)
// a session field the pinned hai-agent-runtime does not accept.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V = String.raw`\d+\.\d+\.\d+`;
export const STAMPS = {
  "packages/sdk/package.json": [new RegExp(String.raw`^(  "version": ")(${V})(")`, "gm")],
  "packages/sdk/src/client/BaseClient.ts": [
    new RegExp(String.raw`("User-Agent": "hai-agents/)(${V})(")`, "g"),
    new RegExp(String.raw`("X-HCompany-Client-Version": ")(${V})(")`, "g"),
  ],
};
const MANIFEST = "packages/sdk/package.json";
const SHIPPED_PATHS = ["packages/sdk/src", "packages/sdk/README.md"];
const PROD_SPECS = ["https://agp.hcompany.ai/share/openapi.json", "https://agp.eu.hcompany.ai/share/openapi.json"];
const RUNTIME_SPEC = "https://assets.hcompanyprod.fr/hai-agent-runtime/{}/openapi.json";
// The local runtime answers every other resource with 501, so only sessions carry fields it must accept.
const RUNTIME_RESOURCE = "/api/v2/sessions";
const METHODS = ["get", "post", "put", "patch", "delete"];

export function currentVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, MANIFEST), "utf8")).version;
}

export function bump(root = ROOT) {
  const old = currentVersion(root);
  const [major, minor, patch] = old.split(".").map(Number);
  const next = `${major}.${minor}.${patch + 1}`;
  const rewritten = Object.entries(STAMPS).map(([file, patterns]) => {
    let text = readFileSync(join(root, file), "utf8");
    for (const pattern of patterns) {
      const found = [...text.matchAll(pattern)].map((match) => match[2]);
      if (found.length !== 1 || found[0] !== old) {
        throw new Error(`${file}: expected one ${pattern} stamped ${old}, found ${JSON.stringify(found)}`);
      }
      text = text.replace(pattern, `$1${next}$3`);
    }
    return [file, text];
  });
  for (const [file, text] of rewritten) writeFileSync(join(root, file), text);
  return next;
}

function publishedManifest(text) {
  const { devDependencies, ...published } = JSON.parse(text);
  return JSON.stringify(published);
}

export function shippedChanged(ref, root = ROOT) {
  const diff = spawnSync("git", ["diff", "--quiet", ref, "HEAD", "--", ...SHIPPED_PATHS], { cwd: root });
  if (diff.status > 1 || diff.error) throw new Error(`git diff ${ref} failed: ${diff.stderr}`);
  if (diff.status === 1) return true;
  const before = execFileSync("git", ["show", `${ref}:${MANIFEST}`], { cwd: root, encoding: "utf8" });
  return publishedManifest(before) !== publishedManifest(readFileSync(join(root, MANIFEST), "utf8"));
}

function operationMap(spec) {
  return Object.fromEntries(
    Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => METHODS.includes(method))
        .map(([method, op]) => [`${method.toUpperCase()} ${path}`, op]),
    ),
  );
}

function operations(spec) {
  return Object.keys(operationMap(spec));
}

/** Every property path `schema` accepts, union branches merged, array items as `[]`. */
function fields(spec, schema, prefix = "", seen = new Set()) {
  const ref = schema.$ref;
  if (ref !== undefined) {
    if (seen.has(ref)) return new Set();
    seen = new Set([...seen, ref]);
    schema = ref.replace(/^#\//, "").split("/").reduce((node, part) => node[part], spec);
  }
  const found = new Set();
  const add = (paths) => paths.forEach((path) => found.add(path));
  for (const key of ["anyOf", "oneOf", "allOf"]) for (const branch of schema[key] ?? []) add(fields(spec, branch, prefix, seen));
  for (const [key, suffix] of [["items", "[]"], ["additionalProperties", ".*"]]) {
    if (schema[key] && typeof schema[key] === "object") add(fields(spec, schema[key], prefix + suffix, seen));
  }
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    found.add(path);
    add(fields(spec, sub, path, seen));
  }
  return found;
}

function bodyFields(spec, op) {
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  return schema ? fields(spec, schema) : new Set();
}

export function missingOperations(sdk, prod) {
  const served = new Set(operations(prod));
  return operations(sdk).filter((op) => !served.has(op)).sort();
}

export function unacceptedSessionFields(sdk, runtime) {
  const served = operationMap(runtime);
  const found = [];
  for (const [name, op] of Object.entries(operationMap(sdk))) {
    if (!name.split(" ")[1].startsWith(RUNTIME_RESOURCE) || !(name in served)) continue;
    const accepted = bodyFields(runtime, served[name]);
    for (const field of bodyFields(sdk, op)) if (!accepted.has(field)) found.push(`${name}: ${field}`);
  }
  return found.sort();
}

/** The spec at `url`, or null when it is not published (403 / 404). */
async function fetchSpec(url) {
  const response = await fetch(url);
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`cannot read ${url}: HTTP ${response.status}`);
  return response.json();
}

async function check(runtimePin, root = ROOT) {
  const sdk = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));
  const runtimeVersion = runtimePin ? JSON.parse(readFileSync(join(root, runtimePin), "utf8")).version : undefined;
  const problems = [];
  for (const url of PROD_SPECS) {
    const prod = await fetchSpec(url);
    if (prod === null) throw new Error(`cannot read ${url}`);
    problems.push(...missingOperations(sdk, prod).map((op) => `${url} does not serve ${op}`));
  }
  if (runtimeVersion) {
    const runtime = await fetchSpec(RUNTIME_SPEC.replace("{}", runtimeVersion));
    if (runtime === null) {
      console.log(`::warning::hai-agent-runtime ${runtimeVersion} has no published openapi.json; skipping its check`);
    } else {
      problems.push(...unacceptedSessionFields(sdk, runtime).map((f) => `hai-agent-runtime ${runtimeVersion} does not accept ${f}`));
    }
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log("release is compatible with prod" + (runtimeVersion ? ` and hai-agent-runtime ${runtimeVersion}` : ""));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "current") console.log(currentVersion());
  else if (command === "bump") console.log(bump());
  else if (command === "changed") console.log(shippedChanged(process.argv[3]));
  else if (command === "check") await check(process.argv[3] === "--runtime-pin" ? process.argv[4] : undefined);
  else throw new Error("usage: node scripts/release.mjs current|bump|changed <ref>|check [--runtime-pin <pin.json>]");
}
