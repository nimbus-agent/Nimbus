import { z } from "zod";

import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
} from "../../shared/mcp-tool-kit.ts";
import {
  clampLimit,
  formatAddress,
  type MailClient,
  type MailMessageMeta,
  type SmtpMailer,
} from "./mail-core.ts";

/**
 * Reduce a {@link MailMessageMeta} to a JSON-safe view. Carries HEADERS,
 * attachment METADATA (filename/size/mimetype), and the capped preview — never
 * attachment bytes or a full body.
 */
function viewMessage(m: MailMessageMeta): Record<string, unknown> {
  const env = m.envelope;
  return {
    uid: m.uid,
    mailbox: m.mailbox,
    uidValidity: m.uidValidity,
    messageId: env.messageId ?? null,
    subject: env.subject ?? null,
    date: env.date instanceof Date ? env.date.toISOString() : (env.date ?? null),
    from: (env.from ?? []).map(formatAddress),
    to: (env.to ?? []).map(formatAddress),
    cc: (env.cc ?? []).map(formatAddress),
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      mimeType: a.mimeType,
    })),
    preview: m.preview,
  };
}

const listArgs = z.object({
  mailbox: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const getArgs = z.object({
  uid: z.number().int().min(1),
  mailbox: z.string().min(1).optional(),
});

const searchArgs = z.object({
  query: z.string().min(1).max(500),
  mailbox: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const sendArgs = z.object({
  to: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

/**
 * Register the ProtonMail (Bridge) read tools + the SMTP send tool onto an MCP
 * server. The IMAP client and SMTP mailer are injected so tests exercise the
 * tool surface without opening real sockets.
 */
export function registerProtonmailTools(
  server: { tool: (...args: never) => unknown },
  client: MailClient,
  mailer: SmtpMailer,
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);

  registerSimpleTool(
    "protonmail_list",
    "List recent ProtonMail messages (via Bridge) — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
    listArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = listArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const opts: { mailbox?: string; limit?: number } = {};
      if (parsed.data.mailbox !== undefined) {
        opts.mailbox = parsed.data.mailbox;
      }
      opts.limit = clampLimit(parsed.data.limit);
      const items = await client.list(opts);
      return mcpJsonResult({ items: items.map(viewMessage) });
    },
  );

  registerSimpleTool(
    "protonmail_get",
    "Fetch one ProtonMail message by uid — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
    getArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = getArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const m = await client.get(parsed.data.uid, parsed.data.mailbox);
      return mcpJsonResult(m === null ? { item: null } : { item: viewMessage(m) });
    },
  );

  registerSimpleTool(
    "protonmail_search",
    "Substring search over message HEADERS (subject/from/to) — returns the same header + attachment-metadata + preview view as protonmail_list. Searches headers only; NEVER scans or returns document/body content beyond the capped preview.",
    searchArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = searchArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const opts: { query: string; mailbox?: string; limit?: number } = {
        query: parsed.data.query,
        limit: clampLimit(parsed.data.limit),
      };
      if (parsed.data.mailbox !== undefined) {
        opts.mailbox = parsed.data.mailbox;
      }
      const items = await client.search(opts);
      return mcpJsonResult({ matches: items.map(viewMessage) });
    },
  );

  registerSimpleTool(
    "protonmail_mail_send",
    "Send a new email over the ProtonMail Bridge SMTP relay. Requires Gateway HITL email.send.",
    sendArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = sendArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const input: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
        to: parsed.data.to,
        subject: parsed.data.subject,
        body: parsed.data.body,
      };
      if (parsed.data.cc !== undefined && parsed.data.cc !== "") {
        input.cc = parsed.data.cc;
      }
      if (parsed.data.bcc !== undefined && parsed.data.bcc !== "") {
        input.bcc = parsed.data.bcc;
      }
      const res = await mailer.send(input);
      return mcpJsonResult({
        messageId: res.messageId,
        accepted: res.accepted,
        rejected: res.rejected,
      });
    },
  );
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const PROTONMAIL_TOOL_NAMES = [
  "protonmail_list",
  "protonmail_get",
  "protonmail_search",
  "protonmail_mail_send",
] as const;
