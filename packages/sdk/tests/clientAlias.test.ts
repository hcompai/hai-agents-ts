import { describe, expect, it } from "vitest";

import { Client, HaiAgentsClient } from "../src/index.js";

// `Client` is the name hai-agents-python exports; `HaiAgentsClient` stays for existing callers.
describe("client name", () => {
  it("HaiAgentsClient is the deprecated alias of Client", () => {
    expect(HaiAgentsClient).toBe(Client);
    expect(new HaiAgentsClient({ apiKey: "k" })).toBeInstanceOf(Client);
  });
});
