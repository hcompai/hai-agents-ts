/** A forced stop SIGKILLs the pid file's process group, so the file is owner-only and refuses planted symlinks. */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

import { pidFilePath, writeOwnerOnly } from "hai-agents-src/local/state";

import { fileMode, readText, tmpPath, writeText } from "./helpers";

const posix = process.platform !== "win32";

it.skipIf(!posix)("pid file written owner only", () => {
  const tmp = tmpPath();
  const filePath = writeOwnerOnly(pidFilePath(4242, tmp), "31337");

  expect(filePath).not.toBeNull();
  expect(readText(filePath!)).toBe("31337");
  expect(fileMode(filePath!)).toBe(0o600);
});

it.skipIf(!posix)("pid file write refuses symlink at path", () => {
  const tmp = tmpPath();
  const victim = path.join(tmp, "victim");
  writeText(victim, "untouched");
  const pidPath = pidFilePath(4242, tmp);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.symlinkSync(victim, pidPath);

  expect(() => writeOwnerOnly(pidPath, "31337")).toThrow();
  expect(readText(victim), "symlink target must not be clobbered").toBe("untouched");
  expect(fs.lstatSync(pidPath).isSymbolicLink(), "the planted symlink itself is left as-is, never written through").toBe(
    true,
  );
});
