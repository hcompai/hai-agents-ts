/**
 * The release updater must never move URLs while retaining a platform's old digest.
 *
 * Python reads the bumped URLs back from manifest.py's MANIFEST dict; manifest.ts composes them from
 * pin.version on demand, so the URL check goes through `artifactUrl`.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

import { artifactUrl } from "hai-agents-src/local/manifest";

import { SDK_ROOT, tmpPath } from "./helpers";

const ROOT = SDK_ROOT;
const RUNTIME = path.join("packages", "sdk", "src", "local");

it.each(["complete", "partial", "unknown-platform", "placeholder-sha"])("release pin update is complete or leaves pin unchanged [%s]", (case_) => {
  const tmp = tmpPath();
  for (const relative of [path.join("scripts", "bump_runtime.mjs"), path.join(RUNTIME, "pin.json")]) {
    fs.mkdirSync(path.dirname(path.join(tmp, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), path.join(tmp, relative));
  }
  const pin = path.join(tmp, RUNTIME, "pin.json");
  const before = fs.readFileSync(pin);
  const original = JSON.parse(before.toString()).sha256 as Record<string, string>;
  const shas: Record<string, string> = Object.fromEntries(
    Object.keys(original).map((platform, index) => [platform, (index + 1).toString(16).padStart(64, "0")]),
  );
  if (case_ === "partial") delete shas[Object.keys(shas).at(-1)!];
  else if (case_ === "unknown-platform") shas["plan9-mips"] = "f".repeat(64);
  else if (case_ === "placeholder-sha") shas[Object.keys(shas)[0]!] = "0".repeat(64);
  const args = [path.join(tmp, "scripts", "bump_runtime.mjs"), "--version", "9.8.7"];
  for (const [platform, sha] of Object.entries(shas)) args.push("--sha", `${platform}=${sha}`);
  const result = spawnSync(process.execPath, args, { encoding: "utf-8" });
  if (case_ !== "complete") {
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(pin).equals(before)).toBe(true);
    return;
  }
  expect(result.status, result.stderr).toBe(0);
  const updated = JSON.parse(fs.readFileSync(pin, "utf-8")) as { version: string; sha256: Record<string, string> };
  expect(updated.version).toBe("9.8.7");
  expect(new Set(Object.keys(updated.sha256))).toEqual(new Set(Object.keys(original)));
  for (const [platform, sha] of Object.entries(updated.sha256)) {
    expect(sha).toBe(shas[platform]);
    expect(artifactUrl(updated.version, platform).endsWith(`/9.8.7/hai-agent-runtime-${platform}.zip`)).toBe(true);
  }
});
