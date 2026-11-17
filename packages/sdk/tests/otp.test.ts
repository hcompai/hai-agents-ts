import { describe, expect, it } from "vitest";

import { imapOtpHandler } from "../src/tools/otp.js";

// imapflow and mailparser are optional dependencies (Python reads mail with the standard library).
describe("imapOtpHandler", () => {
  it("reports the missing optional dependency", async () => {
    const handler = imapOtpHandler({ host: "imap.test", username: "u@test", password: "pw" });
    await expect(handler({ prompt: "Enter the code", kind: "code" })).rejects.toThrow(
      "imapOtpHandler requires the optional dependency 'imapflow'",
    );
  });
});
