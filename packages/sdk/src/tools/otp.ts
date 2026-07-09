/**
 * Prebuilt OTP tool: hand the agent one-time passwords, verification codes, and
 * confirmation links.
 *
 * The agent calls `otpTool` when a login or verification step asks for a code or link
 * sent out of band; the handler resolves it -- interactively on stdin by default, or
 * straight from a mailbox with `imapOtpHandler`.
 */

import { tool, type Tool } from "../client/tools.js";

export const OTP_TOOL_NAME = "request_otp";

export const OTP_TOOL_DESCRIPTION =
  "Ask the human operator for a one-time password (OTP), verification code, or " +
  "confirmation link. Use this whenever a login, signup, or verification step " +
  "asks for a code or link that was sent to the user out of band (email, SMS, " +
  "or an authenticator app). Never guess or fabricate a code: call this tool " +
  "and wait for the value.";

export const OTP_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "Message shown to the user explaining exactly what is needed, " +
        "e.g. 'Enter the 6-digit code sent to j***@example.com'.",
    },
    kind: {
      type: "string",
      enum: ["code", "link"],
      default: "code",
      description: "Whether a code (numeric or alphanumeric) or a full confirmation URL is expected.",
    },
    source: {
      type: "string",
      description: "Where the code or link was sent, e.g. 'email', 'sms', 'authenticator app'.",
    },
  },
  required: ["prompt"],
};

/** One OTP request from the agent, passed to the `otpTool` handler. */
export type OtpRequest = {
  prompt: string;
  kind: "code" | "link";
  source?: string;
};

export type OtpHandler = (request: OtpRequest) => string | Promise<string>;

export type OtpToolOptions = {
  /**
   * Resolves an `OtpRequest` to the value the user supplied (fetch the code from an
   * inbox API, a Slack prompt, ...). Without one, the tool prompts interactively on
   * stdin (Node.js only).
   */
  handler?: OtpHandler;
  name?: string;
  description?: string;
};

/** Interactive fallback: prompt for the value on stdin (Node.js only). */
async function defaultOtpHandler(request: OtpRequest): Promise<string> {
  if (typeof process === "undefined" || !process.stdin) {
    throw new Error("No interactive stdin available; pass a handler to otpTool().");
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const label = request.kind === "link" ? "link" : "code";
    const message = request.source ? `${request.prompt} (sent via ${request.source})` : request.prompt;
    return await rl.question(`${message}\nEnter the ${label}: `);
  } finally {
    rl.close();
  }
}

/**
 * A ready-made custom tool the agent calls when it needs an OTP, verification code,
 * or confirmation link. Without a handler, the tool prompts interactively on stdin.
 *
 * ```ts
 * const handler = imapOtpHandler({
 *   host: "imap.gmail.com",
 *   username: "agent-inbox@gmail.com",
 *   password: process.env.GMAIL_APP_PASSWORD!, // Google app password
 * });
 * await client.runSession({ agent: "surfer", messages: "Log in to example.com", tools: [otpTool({ handler })] });
 * ```
 */
export function otpTool(options: OtpToolOptions = {}): Tool {
  const handler = options.handler ?? defaultOtpHandler;
  return tool({
    name: options.name ?? OTP_TOOL_NAME,
    description: options.description ?? OTP_TOOL_DESCRIPTION,
    inputSchema: OTP_TOOL_INPUT_SCHEMA,
    fn: async (args) => {
      const request: OtpRequest = {
        prompt: typeof args.prompt === "string" ? args.prompt : "The agent needs a one-time password.",
        kind: args.kind === "link" ? "link" : "code",
        source: typeof args.source === "string" ? args.source : undefined,
      };
      const value = (await handler(request)).trim();
      if (!value) {
        throw new Error(`No ${request.kind === "link" ? "link" : "code"} was provided.`);
      }
      return value;
    },
  });
}

const OTP_URL = /https?:\/\/[^\s<>"')\]]+/g;
const OTP_LINK_HINT =
  /verify|confirm|activat|validat|sign-?in|log-?in|magic|authenticat|authoriz|(?<![a-z])oauth|(?<![a-z])auth(?![a-z])|(?<![a-z])otp(?![a-z])|token/i;
const OTP_KEYWORD = /(?:code|otp|passcode|password|pin|token)\b/gi;
const OTP_TOKEN = /\b\d{3,4}(?:[ -]\d{3,4}){1,2}\b|\b[A-Za-z0-9][A-Za-z0-9-]{2,10}[A-Za-z0-9]\b/g;
const OTP_BARE_CODE = /\b\d{3,4}(?:[ -]\d{3,4}){1,2}\b|\b\d{4,8}\b/;

/**
 * Best-effort extraction of an OTP code or confirmation link from an email's text.
 *
 * Links: prefers a URL that looks like a verification/login link, falling back to the
 * first URL. Codes: prefers a digit-bearing token near a keyword ("code", "OTP",
 * "passcode", ...), falling back to any standalone digit run -- contiguous ("482913")
 * or grouped ("123 456", "1234-5678"). `codePattern` replaces the code heuristics;
 * its first capture group (or the whole match) is the code.
 */
export function extractOtp(text: string, kind: "code" | "link" = "code", codePattern?: RegExp): string | undefined {
  if (kind === "link") {
    const urls = text.match(OTP_URL) ?? [];
    return urls.find((url) => OTP_LINK_HINT.test(url)) ?? urls[0];
  }
  if (codePattern) {
    const match = text.match(codePattern);
    return match ? (match[1] ?? match[0]) : undefined;
  }
  // HTML-derived text carries long whitespace runs (stripped tags, table layouts)
  // that would push the code out of the keyword window; collapse them first.
  const collapsed = text.replace(/\s+/g, " ");
  for (const keyword of collapsed.matchAll(OTP_KEYWORD)) {
    const start = (keyword.index ?? 0) + keyword[0].length;
    for (const token of collapsed.slice(start, start + 60).match(OTP_TOKEN) ?? []) {
      if (/\d/.test(token)) {
        return token;
      }
    }
  }
  return collapsed.match(OTP_BARE_CODE)?.[0];
}

function htmlToText(markup: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  return (
    markup
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
      // Surface link targets: html mail hides the URL behind anchor text ("Click here").
      .replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, " $1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity: string) => entities[entity] ?? " ")
  );
}

export type ImapOtpHandlerOptions = {
  host: string;
  username: string;
  password: string;
  /** Defaults to 993 (IMAP over TLS). */
  port?: number;
  /** Mailbox to poll; defaults to "INBOX". */
  mailbox?: string;
  /** Only consider messages from this address, e.g. "no-reply@example.com". */
  sender?: string;
  /** Give up (and report a tool error to the agent) after this long; defaults to 2 minutes. */
  timeoutMs?: number;
  /** Delay between mailbox polls; defaults to 5 seconds. */
  pollIntervalMs?: number;
  /** Ignore unread messages older than this; defaults to 15 minutes. */
  maxAgeMs?: number;
  /** Mark the matched message read so a retry cannot reuse a stale code; defaults to true. */
  markSeen?: boolean;
  /** Replaces the built-in code heuristics; first capture group (or the whole match) is the code. */
  codePattern?: RegExp;
};

// Structural slices of the optional `imapflow` / `mailparser` APIs this handler uses.
type ImapConnection = {
  connect(): Promise<unknown>;
  logout(): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
  fetchOne(
    id: string,
    query: Record<string, unknown>,
    options: { uid: true },
  ): Promise<{ internalDate?: Date; source?: Uint8Array } | false>;
  messageFlagsAdd(id: string, flags: string[], options: { uid: true }): Promise<unknown>;
};
type ImapFlowModule = {
  ImapFlow: new (config: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    logger: false;
  }) => ImapConnection;
};
type MailparserModule = {
  simpleParser(source: Uint8Array): Promise<{ subject?: string; text?: string; html?: string | false }>;
};

async function loadOptional<T>(name: string): Promise<T> {
  // Non-literal specifier: keeps the optional dependency out of the compile-time module graph.
  const specifier = name;
  try {
    return (await import(specifier)) as T;
  } catch {
    throw new Error(`imapOtpHandler requires the optional dependency '${name}': npm install ${name}`);
  }
}

/**
 * An `otpTool` handler that reads the OTP code or confirmation link from a mailbox
 * over IMAP. Polls the mailbox for unread messages (newest first, at most `maxAgeMs`
 * old, optionally filtered by `sender`) and runs `extractOtp` on each until one
 * yields a value; that message is then marked read so a retry cannot reuse a stale
 * code. Works with any IMAP server (for Gmail / Google Workspace use an app password).
 *
 * Privacy: like every custom tool, this runs entirely in your process. The IMAP
 * credentials and connection stay on your machine and are never sent to the API or
 * the agent. The agent cannot browse or read the mailbox: it only calls the tool,
 * and the only thing sent back is the single extracted code or link -- never email
 * bodies, subjects, senders, or any other message content.
 *
 * Requires the optional dependencies `imapflow` and `mailparser`.
 *
 * ```ts
 * const handler = imapOtpHandler({
 *   host: "imap.gmail.com",
 *   username: "agent-inbox@gmail.com",
 *   password: process.env.GMAIL_APP_PASSWORD!,
 *   sender: "no-reply@service-being-logged-into.com",
 * });
 * await client.runSession({ agent: "surfer", messages: "Log in to example.com", tools: [otpTool({ handler })] });
 * ```
 */
export function imapOtpHandler(options: ImapOtpHandlerOptions): OtpHandler {
  const {
    host,
    username,
    password,
    port = 993,
    mailbox = "INBOX",
    sender,
    timeoutMs = 120_000,
    pollIntervalMs = 5_000,
    maxAgeMs = 900_000,
    markSeen = true,
    codePattern,
  } = options;
  return async (request) => {
    const { ImapFlow } = await loadOptional<ImapFlowModule>("imapflow");
    const { simpleParser } = await loadOptional<MailparserModule>("mailparser");
    const deadline = Date.now() + timeoutMs;
    const client = new ImapFlow({ host, port, secure: true, auth: { user: username, pass: password }, logger: false });
    await client.connect();
    try {
      for (;;) {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const query: Record<string, unknown> = { seen: false, since: new Date(Date.now() - maxAgeMs) };
          if (sender) {
            query.from = sender;
          }
          const uids = (await client.search(query, { uid: true })) || [];
          for (const uid of [...uids].sort((a, b) => b - a)) {
            let text: string;
            try {
              const message = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
              if (!message || !message.source) {
                continue;
              }
              if (message.internalDate && Date.now() - message.internalDate.getTime() > maxAgeMs) {
                continue;
              }
              const parsed = await simpleParser(message.source);
              text = [
                parsed.subject ?? "",
                parsed.text ?? "",
                typeof parsed.html === "string" ? htmlToText(parsed.html) : "",
              ].join("\n");
            } catch {
              // One malformed or oversized message must not abort the poll; skip it.
              continue;
            }
            const value = extractOtp(text, request.kind, codePattern);
            if (value) {
              if (markSeen) {
                await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
              }
              return value;
            }
          }
        } finally {
          lock.release();
        }
        if (Date.now() >= deadline) {
          const label = request.kind === "link" ? "link" : "code";
          throw new Error(`No ${label} found in unread mail for ${username} within ${Math.round(timeoutMs / 1000)}s.`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      await Promise.resolve(client.logout()).catch(() => {});
    }
  };
}
