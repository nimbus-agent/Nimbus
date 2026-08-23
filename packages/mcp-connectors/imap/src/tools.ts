import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { registerEmailConnectorTools } from "../../shared/imap-tool-kit.ts";
import { formatAddress, type ImapClient, type SmtpMailer } from "./imap-core.ts";

/**
 * Register the IMAP read tools + the SMTP send tool onto an MCP server. The
 * IMAP client and SMTP mailer are injected so tests exercise the tool surface
 * without opening real sockets.
 */
export function registerImapTools(
  // Widened: the consent kit needs the real server surface, not just the `.tool` shim.
  server: ConsentServer & { tool: (...args: never) => unknown },
  client: ImapClient,
  mailer: SmtpMailer,
): void {
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "imap",
    scopeEnv: "NIMBUS_MCP_IMAP_WRITE_SCOPE",
    scopeKinds: ["recipient"],
  });

  registerEmailConnectorTools({
    server,
    registerWriteTool,
    toolPrefix: "imap",
    descriptions: {
      list: "List recent mailbox messages — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
      get: "Fetch one message by uid — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
      search:
        "Substring search over message HEADERS (subject/from/to) — returns the same header + attachment-metadata + preview view as imap_list. Searches headers only; NEVER scans or returns document/body content beyond the capped preview.",
      send: "Send a new email over SMTP.",
    },
    client,
    mailer,
    formatAddr: formatAddress,
  });
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const IMAP_TOOL_NAMES = ["imap_list", "imap_get", "imap_search", "imap_mail_send"] as const;
