/**
 * Meta checks for the prebuilt tools (`src/tools`), generic over every tool module.
 *
 * Each tool module's exports must be re-exported, object for object, by the package
 * index. New tool modules are discovered from the package directory automatically;
 * adding one requires no test changes here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import * as haiAgentsTools from "hai-agents";

import { SDK_ROOT } from "./helpers";

const packageDir = path.join(SDK_ROOT, "packages", "sdk", "src", "tools");

/** Names of the prebuilt tool modules, discovered from the package directory. */
function _toolModuleNames(): string[] {
  return fs
    .readdirSync(packageDir)
    .filter((file) => /\.(ts|js)$/.test(file) && !/^index\.(ts|js)$/.test(file) && !file.endsWith(".d.ts"))
    .map((file) => file.replace(/\.(ts|js)$/, ""))
    .sort();
}

const exportsOf = (module: object): string[] => Object.keys(module).filter((name) => name !== "default");

const importModule = (moduleName: string) => import(pathToFileURL(path.join(packageDir, `${moduleName}.ts`)).href);

it("at least one tool module is discovered", () => {
  expect(_toolModuleNames()).toContain("otp");
});

it.each(_toolModuleNames())("tool module declares all [%s]", async (moduleName) => {
  const module = await importModule(moduleName);
  expect(exportsOf(module).length, `${moduleName} must export at least one name`).toBeGreaterThan(0);
});

it.each(_toolModuleNames())("tool module reexported by package [%s]", async (moduleName) => {
  const module = await importModule(moduleName);
  for (const name of exportsOf(module)) {
    expect(exportsOf(haiAgentsTools), `${name} missing from hai-agents exports`).toContain(name);
    expect((haiAgentsTools as Record<string, unknown>)[name], `${name} re-export does not match ${moduleName}`).toBe(
      module[name],
    );
  }
});
