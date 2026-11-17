import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// `Client.local()` loads `hai-agents/local` by name at run time (src/client/oo.ts); against the
// sources, that is the local entry's source, not a built copy.
export default defineConfig({
  resolve: { alias: { "hai-agents/local": fileURLToPath(new URL("./src/local/index.ts", import.meta.url)) } },
  // tests/pending: tests whose subject a later branch of the stack brings; that branch moves them into tests/.
  test: { exclude: [...configDefaults.exclude, "tests/pending/**"] },
});
