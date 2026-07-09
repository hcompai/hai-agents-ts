import { describe, expect, it } from "vitest";

import { OTP_TOOL_INPUT_SCHEMA, extractOtp, imapOtpHandler, otpTool } from "../src/tools/otp.js";
import type { OtpRequest } from "../src/tools/otp.js";

describe("otpTool", () => {
  it("builds the default definition", () => {
    const t = otpTool();
    expect(t.name).toBe("request_otp");
    expect(t.description).toContain("one-time password");
    const schema = t.inputSchema as { type: string; required: string[]; properties: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["prompt"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["kind", "prompt", "source"]);
  });

  it("passes the request to the handler and trims the value", async () => {
    const seen: OtpRequest[] = [];
    const t = otpTool({
      handler: (request) => {
        seen.push(request);
        return "  123456  ";
      },
    });
    await expect(t.fn({ prompt: "Enter the code sent to a@b.com", kind: "code", source: "email" })).resolves.toBe(
      "123456",
    );
    expect(seen).toEqual([{ prompt: "Enter the code sent to a@b.com", kind: "code", source: "email" }]);
  });

  it("defaults kind and source", async () => {
    const seen: OtpRequest[] = [];
    const t = otpTool({
      handler: (request) => {
        seen.push(request);
        return "ok";
      },
    });
    await t.fn({ prompt: "Enter the code" });
    expect(seen).toEqual([{ prompt: "Enter the code", kind: "code", source: undefined }]);
  });

  it("rejects empty values", async () => {
    await expect(otpTool({ handler: () => "   " }).fn({ prompt: "Enter the code" })).rejects.toThrow(
      "No code was provided.",
    );
    await expect(otpTool({ handler: () => "" }).fn({ prompt: "Open the link", kind: "link" })).rejects.toThrow(
      "No link was provided.",
    );
  });

  it("supports async handlers", async () => {
    const t = otpTool({ handler: async () => " 654321 " });
    await expect(t.fn({ prompt: "Enter the code" })).resolves.toBe("654321");
  });

  it("supports name and description overrides", () => {
    const t = otpTool({ handler: () => "x", name: "get_2fa_code", description: "Fetch the 2FA code." });
    expect(t.name).toBe("get_2fa_code");
    expect(t.description).toBe("Fetch the 2FA code.");
    expect(t.inputSchema).toBe(OTP_TOOL_INPUT_SCHEMA);
  });
});

describe("extractOtp", () => {
  it("finds a code near a keyword", () => {
    expect(extractOtp("Your verification code is 482913. It expires in 10 minutes.")).toBe("482913");
    expect(extractOtp("Your OTP code is 1234")).toBe("1234");
  });

  it("finds grouped digits", () => {
    expect(extractOtp("Enter 123 456 to continue")).toBe("123 456");
    expect(extractOtp("Your code is 1234-5678")).toBe("1234-5678");
    expect(extractOtp("Use 123 456 789 now")).toBe("123 456 789");
  });

  it("collapses whitespace from html layouts", () => {
    // Table-based HTML mail turns into text with the code far from the keyword.
    const text = "Your verification code\n\n\n" + " ".repeat(50) + "\n\n482913";
    expect(extractOtp(text)).toBe("482913");
  });

  it("finds alphanumeric codes", () => {
    expect(extractOtp("Use passcode 7GK4-P2Q to continue.")).toBe("7GK4-P2Q");
  });

  it("falls back to bare digits", () => {
    expect(extractOtp("314159 is your Acme sign-in key")).toBe("314159");
  });

  it("honors a custom pattern's capture group", () => {
    expect(extractOtp("Ticket ABC-99-XYZ opened", "code", /Ticket ([A-Z0-9-]+)/)).toBe("ABC-99-XYZ");
  });

  it("prefers verification-looking links", () => {
    const text =
      "View in browser: https://news.example.com/open?id=1 Confirm: https://app.example.com/verify?token=abc";
    expect(extractOtp(text, "link")).toBe("https://app.example.com/verify?token=abc");
  });

  it("ignores hint words embedded in other words", () => {
    // "authors" / "hotpicks" must not trip the "auth" / "otp" hints and outrank the real link.
    const text =
      "Meet our team: https://blog.example.com/authors/jane " +
      "Deals: https://shop.example.com/hotpicks " +
      "Confirm your account: https://app.example.com/verify?id=1";
    expect(extractOtp(text, "link")).toBe("https://app.example.com/verify?id=1");
  });

  it("still matches auth path segments", () => {
    expect(extractOtp("Docs: https://docs.example.com/start Login: https://id.example.com/auth/callback?sid=9", "link")).toBe(
      "https://id.example.com/auth/callback?sid=9",
    );
    expect(extractOtp("Docs: https://docs.example.com/start Login: https://oauth.example.com/approve?sid=9", "link")).toBe(
      "https://oauth.example.com/approve?sid=9",
    );
  });

  it("falls back to the first url", () => {
    expect(extractOtp("See https://example.com/a then https://example.com/b", "link")).toBe("https://example.com/a");
  });

  it("returns undefined when nothing matches", () => {
    expect(extractOtp("Hello there, nothing to see.")).toBeUndefined();
    expect(extractOtp("Hello there, nothing to see.", "link")).toBeUndefined();
  });
});

describe("imapOtpHandler", () => {
  it("reports the missing optional dependency", async () => {
    const handler = imapOtpHandler({ host: "imap.test", username: "u@test", password: "pw" });
    await expect(handler({ prompt: "Enter the code", kind: "code" })).rejects.toThrow(
      "imapOtpHandler requires the optional dependency 'imapflow'",
    );
  });
});
