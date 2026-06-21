import { registerEmailConnectorTools } from "../../shared/imap-tool-kit.ts";
import { formatAddress, type ImapClient, type SmtpMailer } from "./imap-core.ts";

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
  registerEmailConnectorTools({
    server,
    toolPrefix: "imap",
    descriptions: {
      list: "List recent mailbox messages — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
      get: "Fetch one message by uid — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
      search:
        "Substring search over message HEADERS (subject/from/to) — returns the same header + attachment-metadata + preview view as imap_list. Searches headers only; NEVER scans or returns document/body content beyond the capped preview.",
      send: "Send a new email over SMTP. Requires Gateway HITL email.send.",
    },
    client,
    mailer,
    formatAddr: formatAddress,
  });
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const IMAP_TOOL_NAMES = ["imap_list", "imap_get", "imap_search", "imap_mail_send"] as const;
