// Release helpers: `current` prints the SDK version, `bump` raises its patch in every file
// that stamps it, `changed <ref>` tells whether the published package changed since <ref>,
// `check` fails when the API spec needs an operation prod does not serve.
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

function operations(spec) {
  return Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item).filter((method) => METHODS.includes(method)).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

export function missingOperations(sdk, prod) {
  const served = new Set(operations(prod));
  return operations(sdk).filter((op) => !served.has(op)).sort();
}

async function check(root = ROOT) {
  const sdk = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));
  const problems = [];
  for (const url of PROD_SPECS) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cannot read ${url}: HTTP ${response.status}`);
    problems.push(...missingOperations(sdk, await response.json()).map((op) => `${url} does not serve ${op}`));
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log("release is compatible with prod");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "current") console.log(currentVersion());
  else if (command === "bump") console.log(bump());
  else if (command === "changed") console.log(shippedChanged(process.argv[3]));
  else if (command === "check") await check();
  else throw new Error("usage: node scripts/release.mjs current|bump|changed <ref>|check");
}
