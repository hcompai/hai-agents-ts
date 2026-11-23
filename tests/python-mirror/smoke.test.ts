/** Offline smoke checks: the package imports, clients construct, models parse. */
import { expect, it } from "vitest";

import { serialization } from "hai-agents";

import { Client } from "./client";

it("clients construct and expose resources", () => {
  const client = new Client({ apiKey: "hk-smoke", baseUrl: "http://x" });
  for (const resource of ["sessions", "agents", "skills", "environments"]) {
    expect(resource in client, `missing resource namespace: ${resource}`).toBe(true);
  }
});

it("core model round trips", () => {
  const status = serialization.SessionStatus.parseOrThrow({ status: "completed", steps: 3 });
  expect(status.status).toBe("completed");
  expect(status.steps).toBe(3);
  expect(serialization.SessionStatus.jsonOrThrow(status).status).toBe("completed");
});
