import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// Browser clients (extensions, web apps) bundle the SDK with a browser target, where a
// Node built-in import is a build failure.

describe("browser bundle", () => {
  it("bundles the whole entrypoint without any Node built-in", async () => {
    const result = await build({
      entryPoints: ["src/index.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const bundled = result.outputFiles![0]!.text;
    expect(bundled).not.toMatch(/from\s*"node:|import\(\s*"node:|require\(\s*"node:/);
  });
});
