/**
 * conftest.py. The Python suite's autouse fixtures patch the CLI, the desktop lock and the update
 * check, none of which exist in the TS SDK; what remains is `_no_auto_bridges`, and undoing each
 * test's monkeypatches and temp dirs.
 */
import { afterEach, beforeEach } from "vitest";

import { _defaultManager } from "hai-agents-src/local/manager";

import { cleanupTmpPaths, mp } from "./helpers";

beforeEach(() => {
  // _no_auto_bridges: Python turns the client's auto_bridges off; TS has no HAI_AUTO_BRIDGE and no class switch, so a
  // test that would start a bridge without faking the manager fails here instead of launching a browser.
  mp.setattr(_defaultManager, "ensure", async () => {
    throw new Error("a test started a bridge without faking the manager (setup.ts)");
  });
});

afterEach(() => {
  mp.undo();
  cleanupTmpPaths();
});
