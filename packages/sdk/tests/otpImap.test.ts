/**
 * imapOtpHandler behavior against mocked `imapflow` / `mailparser` modules.
 *
 * Kept separate from otp.test.ts: the mocks below are file-scoped, and otp.test.ts
 * asserts the missing-optional-dependency error for these very modules.
 */
import { describe, expect, it, vi } from "vitest";

import { imapOtpHandler } from "../src/tools/otp.js";

const state = vi.hoisted(() => ({
  flagged: [] as Array<{ id: string; flags: string[] }>,
  fetched: [] as string[],
}));

vi.mock("imapflow", () => {
  class FakeImapFlow {
    async connect() {}
    async logout() {}
    async getMailboxLock(_path: string) {
      return { release() {} };
    }
    async search(_query: Record<string, unknown>, _options: { uid: true }) {
      return [1, 2];
    }
    async fetchOne(id: string, _query: Record<string, unknown>, _options: { uid: true }) {
      state.fetched.push(id);
      // The newest message (uid 2, polled first) is broken; the older one carries the code.
      const body = id === "2" ? "BOOM" : "Your login code is 271828.";
      return { internalDate: new Date(), source: new TextEncoder().encode(body) };
    }
    async messageFlagsAdd(id: string, flags: string[], _options: { uid: true }) {
      state.flagged.push({ id, flags });
    }
  }
  return { ImapFlow: FakeImapFlow };
});

vi.mock("mailparser", () => ({
  simpleParser: async (source: Uint8Array) => {
    const text = new TextDecoder().decode(source);
    if (text.includes("BOOM")) {
      throw new Error("malformed message");
    }
    return { subject: "Your login code", text };
  },
}));

describe("imapOtpHandler with a mocked mailbox", () => {
  it("skips a message that fails to fetch or parse and keeps polling", async () => {
    const handler = imapOtpHandler({ host: "imap.test", username: "u@test", password: "pw" });
    await expect(handler({ prompt: "Enter the code", kind: "code" })).resolves.toBe("271828");
    expect(state.fetched).toEqual(["2", "1"]);
    expect(state.flagged).toEqual([{ id: "1", flags: ["\\Seen"] }]);
  });
});
