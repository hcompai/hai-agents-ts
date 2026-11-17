/** A release bumps every version stamp together and refuses specs that prod cannot serve. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { SDK_ROOT, readText, tmpPath, writeText } from "./helpers";

const ROOT = SDK_ROOT;

type Spec = { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };

interface Release {
  STAMPS: Record<string, RegExp[]>;
  currentVersion(root: string): string;
  bump(root: string): string;
  shippedChanged(ref: string, root: string): boolean;
  missingOperations(sdk: Spec, prod: Spec): string[];
}

// runpy.run_path(...): both helpers live in scripts/release.mjs on the TS side.
const bumpVersion = (await import(pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href)) as Release;
const checkRelease = bumpVersion;

function _copyStampedFiles(root: string): void {
  for (const relative of Object.keys(bumpVersion.STAMPS)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), path.join(root, relative));
  }
}

/** `pattern.findall(text)` for a three-group pattern, keeping the middle (stamp) group. */
function stamps(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].map(
    (match) => match[2],
  );
}

it("bump moves every stamp to the next patch", () => {
  const tmp = tmpPath();
  _copyStampedFiles(tmp);
  const [major, minor, patch] = bumpVersion.currentVersion(tmp).split(".");

  const new_ = bumpVersion.bump(tmp);

  expect(new_).toBe(`${major}.${minor}.${Number(patch) + 1}`);
  for (const [relative, patterns] of Object.entries(bumpVersion.STAMPS)) {
    const text = readText(path.join(tmp, relative));
    expect(
      patterns.every((pattern) => JSON.stringify(stamps(pattern, text)) === JSON.stringify([new_])),
      relative,
    ).toBe(true);
  }
});

it("bump writes nothing when a stamp is out of step", () => {
  const tmp = tmpPath();
  _copyStampedFiles(tmp);
  const wrapper = path.join(tmp, "packages/sdk/src/client/BaseClient.ts");
  writeText(wrapper, readText(wrapper).replace('"X-HCompany-Client-Version": "', '"X-HCompany-Client-Version": "9'));
  const before = Object.fromEntries(Object.keys(bumpVersion.STAMPS).map((relative) => [relative, readText(path.join(tmp, relative))]));

  // SystemExit
  expect(() => bumpVersion.bump(tmp)).toThrow();

  expect(Object.fromEntries(Object.keys(bumpVersion.STAMPS).map((relative) => [relative, readText(path.join(tmp, relative))]))).toEqual(
    before,
  );
});

it("only changes to the wheel call for a release", () => {
  const tmp = tmpPath();
  const config = "-c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false".split(" ");

  function git(...args: string[]): void {
    const done = spawnSync("git", [...config, ...args], { cwd: tmp, encoding: "utf-8" });
    if (done.status !== 0) throw new Error(done.stderr);
  }

  function commit(dependency: string, devDependency: string): void {
    writeText(
      path.join(tmp, "packages/sdk/package.json"),
      JSON.stringify({ version: "1.0.0", dependencies: { httpx: dependency }, devDependencies: { pytest: devDependency } }, null, 2),
    );
    git("add", ".");
    git("commit", "-qm", "change");
  }

  fs.mkdirSync(path.join(tmp, "packages/sdk/src"), { recursive: true });
  writeText(path.join(tmp, "packages/sdk/src/module.ts"), "");
  git("init", "-q");
  commit("httpx>=0.27", "pytest>=9");
  git("tag", "v1.0.0");

  commit("httpx>=0.27", "pytest>=9.1");
  expect(bumpVersion.shippedChanged("v1.0.0", tmp)).toBe(false);

  commit("httpx>=0.28", "pytest>=9.1");
  expect(bumpVersion.shippedChanged("v1.0.0", tmp)).toBe(true);
});

function _spec(paths: Record<string, unknown>, schemas: Record<string, unknown> | null = null): Spec {
  return { paths, components: { schemas: schemas ?? {} } };
}

it("operations prod does not serve block the release", () => {
  const sdk = _spec({ "/api/v2/agents": { get: {} }, "/api/v2/agents/{name}/restore": { post: {} } });
  const prod = _spec({ "/api/v2/agents": { get: {} } });

  expect(checkRelease.missingOperations(sdk, prod)).toEqual(["POST /api/v2/agents/{name}/restore"]);
});
