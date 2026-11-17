/**
 * conftest.py. The Python suite's autouse fixtures patch the CLI, the desktop lock and the update
 * check, none of which exist in the TS SDK; what remains is `_no_auto_bridges`, and undoing each
 * test's monkeypatches and temp dirs.
 */
import { afterEach, beforeEach } from "vitest";

import { cleanupTmpPaths, mp } from "./helpers";

beforeEach(() => {
  // AUTO_BRIDGE_ENV_VAR of hai-agents/local (src/local/config.ts) by its literal name: setup.ts runs on every branch of the stack, before the bridge layer exists.
  mp.setenv("HAI_AUTO_BRIDGE", "0");
});

afterEach(() => {
  mp.undo();
  cleanupTmpPaths();
});
