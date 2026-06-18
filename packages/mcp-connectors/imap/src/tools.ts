import { emailToolSchemas, viewEmailMessage } from "../../shared/imap-tool-kit.ts";
import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { clampLimit, formatAddress, type ImapClient, type SmtpMailer } from "./imap-core.ts";

/**
 * Register the IMAP read tools + the SMTP send tool onto an MCP server. The
 * IMAP client and SMTP mailer are injected so tests exercise the tool surface
 * without opening real sockets.
 */
export function registerImapTools(
  server: { tool: (...args: never) => unknown },
  client: ImapClient,
  mailer: SmtpMailer,
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const { listArgs, getArgs, searchArgs, sendArgs } = emailToolSchemas;

  registerSimpleTool(
    "imap_list",
    "List recent mailbox messages — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
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
      return mcpJsonResult({ items: items.map((m) => viewEmailMessage(m, formatAddress)) });
    },
  );

  registerSimpleTool(
    "imap_get",
    "Fetch one message by uid — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
    getArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = getArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const m = await client.get(parsed.data.uid, parsed.data.mailbox);
      return mcpJsonResult(
        m === null ? { item: null } : { item: viewEmailMessage(m, formatAddress) },
      );
    },
  );

  registerSimpleTool(
    "imap_search",
    "Substring search over message HEADERS (subject/from/to) — returns the same header + attachment-metadata + preview view as imap_list. Searches headers only; NEVER scans or returns document/body content beyond the capped preview.",
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
      return mcpJsonResult({ matches: items.map((m) => viewEmailMessage(m, formatAddress)) });
    },
  );

  registerSimpleTool(
    "imap_mail_send",
    "Send a new email over SMTP. Requires Gateway HITL email.send.",
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
export const IMAP_TOOL_NAMES = ["imap_list", "imap_get", "imap_search", "imap_mail_send"] as const;
