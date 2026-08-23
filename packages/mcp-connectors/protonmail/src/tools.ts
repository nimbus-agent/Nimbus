import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { registerEmailConnectorTools } from "../../shared/imap-tool-kit.ts";
import { formatAddress, type MailClient, type SmtpMailer } from "./mail-core.ts";

/**
 * Register the ProtonMail (Bridge) read tools + the SMTP send tool onto an MCP
 * server. The IMAP client and SMTP mailer are injected so tests exercise the
 * tool surface without opening real sockets.
 */
export function registerProtonmailTools(
  // Widened: the consent kit needs the real server surface, not just the `.tool` shim.
  server: ConsentServer & { tool: (...args: never) => unknown },
  client: MailClient,
  mailer: SmtpMailer,
): void {
  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "protonmail",
    scopeEnv: "NIMBUS_MCP_PROTONMAIL_WRITE_SCOPE",
    scopeKinds: ["recipient"],
  });

  registerEmailConnectorTools({
    server,
    registerWriteTool,
    toolPrefix: "protonmail",
    descriptions: {
      list: "List recent ProtonMail messages (via Bridge) — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
      get: "Fetch one ProtonMail message by uid — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
      search:
        "Substring search over message HEADERS (subject/from/to) — returns the same header + attachment-metadata + preview view as protonmail_list. Searches headers only; NEVER scans or returns document/body content beyond the capped preview.",
      send: "Send a new email over the ProtonMail Bridge SMTP relay. Requires Gateway HITL email.send.",
    },
    client,
    mailer,
    formatAddr: formatAddress,
  });
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const PROTONMAIL_TOOL_NAMES = [
  "protonmail_list",
  "protonmail_get",
  "protonmail_search",
  "protonmail_mail_send",
] as const;
