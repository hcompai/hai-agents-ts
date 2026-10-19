import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { STAMPS, bump, currentVersion, missingOperations } from "./release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyStampedFiles() {
  const root = mkdtempSync(join(tmpdir(), "release-"));
  for (const file of Object.keys(STAMPS)) cpSync(join(ROOT, file), join(root, file));
  return root;
}

const read = (root) => Object.fromEntries(Object.keys(STAMPS).map((file) => [file, readFileSync(join(root, file), "utf8")]));

test("bump moves every stamp to the next patch", () => {
  const root = copyStampedFiles();
  const [major, minor, patch] = currentVersion(root).split(".").map(Number);

  const next = bump(root);

  assert.equal(next, `${major}.${minor}.${patch + 1}`);
  for (const [file, patterns] of Object.entries(STAMPS)) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of patterns) assert.deepEqual([...text.matchAll(pattern)].map((m) => m[2]), [next], file);
  }
});

test("bump writes nothing when a stamp is out of step", () => {
  const root = copyStampedFiles();
  const client = join(root, "packages/sdk/src/client/BaseClient.ts");
  writeFileSync(client, readFileSync(client, "utf8").replace('"X-HCompany-Client-Version": "', '"X-HCompany-Client-Version": "9'));
  const before = read(root);

  assert.throws(() => bump(root));

  assert.deepEqual(read(root), before);
});

test("operations prod does not serve block the release", () => {
  const sdk = { paths: { "/api/v2/agents": { get: {} }, "/api/v2/agents/{name}/restore": { post: {}, parameters: [] } } };
  const prod = { paths: { "/api/v2/agents": { get: {} } } };

  assert.deepEqual(missingOperations(sdk, prod), ["POST /api/v2/agents/{name}/restore"]);
});
