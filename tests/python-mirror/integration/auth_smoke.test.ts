/**
 * Cheapest possible auth check: hit /sessions/quota and confirm a typed
 * response comes back. A 401/403 raises HaiAgentsError (wrong key); a 200 means auth +
 * base_url + the SDK's response parsing all work. Runs in well under a second, so
 * it's a good gate before the heavier tests.
 */
import { describe, expect, it } from "vitest";

import { client, skipReason } from "./fixtures";

// pytestmark = pytest.mark.integration
describe.skipIf(skipReason() !== null)("integration", () => {
  it("quota endpoint authenticates", async () => {
    const quota = await client().sessions.getSessionQuota();
    expect(quota.limit).toBeGreaterThan(0);
    expect(quota.active).toBeGreaterThanOrEqual(0);
    expect(quota.available).toBe(quota.limit - quota.active);
  });
});
