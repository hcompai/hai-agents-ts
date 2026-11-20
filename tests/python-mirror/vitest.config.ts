import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsconfig = JSON.parse(fs.readFileSync(path.join(here, "tsconfig.json"), "utf-8"));

// One source of truth for module paths: the `paths` map in tsconfig.json, turned into vite aliases.
// `hai-agents` and `hai-agents/local` resolve to ../../packages/sdk/src, so the tests run against
// the SDK sources of this checkout, not the published package.
const alias = Object.entries(tsconfig.compilerOptions.paths as Record<string, string[]>).map(([key, [target]]) => {
  const name = key.replace(/\/\*$/, "");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    find: new RegExp(key.endsWith("/*") ? `^${escaped}(?=/)` : `^${escaped}$`),
    replacement: path.resolve(here, target.replace(/\/\*$/, "")),
  };
});

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    include: ["*.test.ts", "integration/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    setupFiles: ["./setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests patch process-wide state (env vars, module attributes); run one file at a time.
    pool: "forks",
    maxWorkers: 1,
  },
});
