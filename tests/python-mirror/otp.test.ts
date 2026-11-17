/**
 * Behavior tests for the prebuilt OTP tool (`src/tools/otp`).
 *
 * Package resolution and re-export meta checks live in tools_package.test.ts; this file
 * only tests the OTP tool's behavior.
 */
import { beforeEach, expect, it, vi } from "vitest";

import { OTP_TOOL_INPUT_SCHEMA, extractOtp, imapOtpHandler, otpTool, toolDefinition } from "hai-agents";
import type { OtpRequest } from "hai-agents";

import { htmlToText } from "hai-agents-src/tools/otp";

import { mp, raisesAsync } from "./helpers";

it("otp tool definition defaults", () => {
  const t = otpTool();
  const definition = toolDefinition(t) as Record<string, any>;
  expect(definition.name).toBe("request_otp");
  expect(definition.description).toContain("one-time password");
  const schema = definition.input_schema;
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["prompt"]);
  expect(new Set(Object.keys(schema.properties))).toEqual(new Set(["prompt", "kind", "source"]));
  expect(schema.properties.kind.enum).toEqual(["code", "link"]);
});

it("otp tool custom handler receives request and trims", async () => {
  const seen: OtpRequest[] = [];

  function handler(request: OtpRequest): string {
    seen.push(request);
    return "  123456  ";
  }

  const t = otpTool({ handler });
  expect(await t.fn({ prompt: "Enter the code sent to a@b.com", kind: "code", source: "email" })).toBe("123456");
  expect(seen).toEqual([{ prompt: "Enter the code sent to a@b.com", kind: "code", source: "email" }]);
});

it("otp tool defaults kind and source", async () => {
  const seen: OtpRequest[] = [];

  function handler(request: OtpRequest): string {
    seen.push(request);
    return "ok";
  }

  await otpTool({ handler }).fn({ prompt: "Enter the code" });
  expect(seen).toEqual([{ prompt: "Enter the code", kind: "code", source: undefined }]);
});

it("otp tool empty value raises", async () => {
  let t = otpTool({ handler: (_request) => "   " });
  await raisesAsync(() => t.fn({ prompt: "Enter the code" }), Error, /No code/);
  t = otpTool({ handler: (_request) => "" });
  await raisesAsync(() => t.fn({ prompt: "Open the link", kind: "link" }), Error, /No link/);
});

it("otp tool async handler", async () => {
  async function handler(_request: OtpRequest): Promise<string> {
    return " 654321 ";
  }

  const result = otpTool({ handler }).fn({ prompt: "Enter the code" });
  expect(await _await(result as Promise<string>)).toBe("654321");
});

async function _await(value: Promise<string> | string): Promise<string> {
  return await value;
}

it("otp tool name and description overrides", () => {
  const t = otpTool({ handler: (_request) => "x", name: "get_2fa_code", description: "Fetch the 2FA code." });
  expect(toolDefinition(t)).toEqual({
    name: "get_2fa_code",
    description: "Fetch the 2FA code.",
    input_schema: OTP_TOOL_INPUT_SCHEMA,
  });
});

it("extract otp code near keyword", () => {
  expect(extractOtp("Your verification code is 482913. It expires in 10 minutes.")).toBe("482913");
  expect(extractOtp("Your OTP code is 1234")).toBe("1234");
});

it("extract otp grouped digits", () => {
  expect(extractOtp("Enter 123 456 to continue")).toBe("123 456");
  expect(extractOtp("Your code is 1234-5678")).toBe("1234-5678");
  expect(extractOtp("Use 123 456 789 now")).toBe("123 456 789");
});

it("extract otp collapses whitespace from html layouts", () => {
  // Table-based HTML mail turns into text with the code far from the keyword.
  const text = "Your verification code\n\n\n" + " ".repeat(50) + "\n\n482913";
  expect(extractOtp(text)).toBe("482913");
});

it("extract otp alphanumeric code", () => {
  expect(extractOtp("Use passcode 7GK4-P2Q to continue.")).toBe("7GK4-P2Q");
});

it("extract otp bare digits fallback", () => {
  expect(extractOtp("314159 is your Acme sign-in key")).toBe("314159");
});

it("extract otp custom pattern capture group", () => {
  expect(extractOtp("Ticket ABC-99-XYZ opened", "code", /Ticket ([A-Z0-9-]+)/)).toBe("ABC-99-XYZ");
});

it("extract otp link prefers verification url", () => {
  const text = "View in browser: https://news.example.com/open?id=1 Confirm: https://app.example.com/verify?token=abc";
  expect(extractOtp(text, "link")).toBe("https://app.example.com/verify?token=abc");
});

it("extract otp link hint ignores embedded words", () => {
  // "authors" / "hotpicks" must not trip the "auth" / "otp" hints and outrank the real link.
  const text =
    "Meet our team: https://blog.example.com/authors/jane " +
    "Deals: https://shop.example.com/hotpicks " +
    "Confirm your account: https://app.example.com/verify?id=1";
  expect(extractOtp(text, "link")).toBe("https://app.example.com/verify?id=1");
});

it("extract otp link hint still matches auth segments", () => {
  let text = "Docs: https://docs.example.com/start Login: https://id.example.com/auth/callback?sid=9";
  expect(extractOtp(text, "link")).toBe("https://id.example.com/auth/callback?sid=9");
  text = "Docs: https://docs.example.com/start Login: https://oauth.example.com/approve?sid=9";
  expect(extractOtp(text, "link")).toBe("https://oauth.example.com/approve?sid=9");
});

it("extract otp link falls back to first url", () => {
  expect(extractOtp("See https://example.com/a then https://example.com/b", "link")).toBe("https://example.com/a");
});

it("extract otp no match returns none", () => {
  expect(extractOtp("Hello there, nothing to see.")).toBeUndefined();
  expect(extractOtp("Hello there, nothing to see.", "link")).toBeUndefined();
});

// Adapted from test_otp.py::test_otp_tool_default_handler_prompts_stdin. Python patches
// `builtins.input`; the TS default handler reads stdin through `node:readline/promises`, loaded
// with process.getBuiltinModule, so the patch point is that loader. The prompt text is identical.
it("otp tool default handler prompts stdin", async () => {
  const prompts: string[] = [];

  const fakeReadline = {
    createInterface: () => ({
      question: async (prompt: string) => {
        prompts.push(prompt);
        return "42";
      },
      close() {},
    }),
  };
  mp.setattr(process, "getBuiltinModule", ((name: string) => (name === "node:readline/promises" ? fakeReadline : process.getBuiltinModule(name))) as never);
  expect(await otpTool().fn({ prompt: "Enter the 6-digit code", source: "sms" })).toBe("42");
  expect(prompts).toEqual(["Enter the 6-digit code (sent via sms)\nEnter the code: "]);
});

/**
 * Two unread messages; only the newest (id 2) carries a code.
 *
 * The TS handler talks imapflow + mailparser (loaded lazily), so the fake mailbox is a module
 * mock of those two packages, configured per test through `imap`.
 */
const imap = vi.hoisted(() => ({
  host: "",
  port: 0,
  credentials: null as [string, string] | null,
  mailbox: null as string | null,
  searches: [] as Record<string, unknown>[],
  stored: [] as [string, string[]][],
  fetched: [] as string[],
  loggedOut: false,
  uids: [1, 2] as number[],
  brokenNewest: false,
  reset() {
    Object.assign(this, { host: "", port: 0, credentials: null, mailbox: null, searches: [], stored: [], fetched: [], loggedOut: false, uids: [1, 2], brokenNewest: false });
  },
}));

vi.mock("imapflow", () => {
  class _FakeImapConn {
    constructor(config: { host: string; port: number; auth: { user: string; pass: string } }) {
      imap.host = config.host;
      imap.port = config.port;
      imap.credentials = [config.auth.user, config.auth.pass];
    }

    async connect(): Promise<void> {}

    async getMailboxLock(mailbox: string) {
      imap.mailbox = mailbox;
      return { release() {} };
    }

    async search(query: Record<string, unknown>, _options: { uid: true }) {
      imap.searches.push(query);
      return imap.uids;
    }

    async fetchOne(msgId: string, _query: Record<string, unknown>, _options: { uid: true }) {
      imap.fetched.push(msgId);
      if (imap.brokenNewest && msgId === "2") throw new Error("FETCH failed");
      const bodies: Record<string, string> = imap.brokenNewest
        ? { "1": "Subject: Your login code\r\nContent-Type: text/plain\r\n\r\nYour login code is 271828.\r\n" }
        : {
            "1": "Subject: Welcome\r\nContent-Type: text/plain\r\n\r\nThanks for signing up!\r\n",
            "2": "Subject: Your login code\r\nContent-Type: text/plain\r\n\r\nYour login code is 314159.\r\n",
          };
      return { internalDate: new Date(), source: new TextEncoder().encode(bodies[msgId]) };
    }

    async messageFlagsAdd(msgId: string, flags: string[], _options: { uid: true }): Promise<void> {
      imap.stored.push([msgId, flags]);
    }

    async logout(): Promise<void> {
      imap.loggedOut = true;
    }
  }
  return { ImapFlow: _FakeImapConn };
});

vi.mock("mailparser", () => ({
  simpleParser: async (source: Uint8Array) => {
    const [headers, body] = new TextDecoder().decode(source).split("\r\n\r\n");
    return { subject: headers.match(/^Subject: (.*)$/m)?.[1], text: body };
  },
}));

beforeEach(() => imap.reset());

it("html to text surfaces hrefs and entities", () => {
  const text = htmlToText('<style>.x{color:red}</style><p>Click <a href="https://x.test/verify?t=1">here</a>&nbsp;to verify</p>');
  expect(text).toContain("https://x.test/verify?t=1");
  expect(text).toContain("to verify");
  expect(text).not.toContain("color:red");
});

it("imap otp handler reads newest unread and marks seen", async () => {
  const handler = imapOtpHandler({ host: "imap.test", username: "u@test", password: "pw", sender: "no-reply@x.test" });
  expect(await handler({ prompt: "Enter the code", kind: "code" })).toBe("314159");
  const conn = imap;
  expect(conn.credentials).toEqual(["u@test", "pw"]);
  expect(conn.searches).toEqual([{ seen: false, since: expect.any(Date), from: "no-reply@x.test" }]);
  expect(conn.stored).toEqual([["2", ["\\Seen"]]]);
  expect(conn.loggedOut).toBe(true);
});

it("imap otp handler skips message that fails to fetch or parse", async () => {
  imap.brokenNewest = true;
  const handler = imapOtpHandler({ host: "imap.test", username: "u@test", password: "pw" });
  expect(await handler({ prompt: "Enter the code", kind: "code" })).toBe("271828");
  expect(imap.fetched).toEqual(["2", "1"]); // newest first, then the older one that carries the code
  expect(imap.stored).toEqual([["1", ["\\Seen"]]]);
});

it("imap otp handler times out", async () => {
  imap.uids = [];
  const handler = imapOtpHandler({ host: "imap.test", username: "u@test", password: "pw", timeoutMs: 0 });
  await raisesAsync(() => handler({ prompt: "Enter the code", kind: "code" }), Error, /No code found/);
  expect(imap.loggedOut).toBe(true);
});
