import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type FetchMessageObject, type FetchQueryObject, ImapFlow } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import {
  type BodyStructureNode,
  extractAttachments,
  findTextPlainPart,
} from "../../shared/imap-bodystructure.ts";
import { envInt, previewFromParts } from "../../shared/imap-tool-kit.ts";
import { requireProcessEnv } from "../../shared/mcp-tool-kit.ts";
import {
  clampLimit,
  type MailClient,
  type MailEnvelope,
  type MailListOptions,
  type MailMessageMeta,
  type MailSearchOptions,
  PREVIEW_FETCH_BYTES,
  type SendMailInput,
  type SendMailResult,
  type SmtpMailer,
} from "./mail-core.ts";
import { registerProtonmailTools } from "./tools.ts";

// ProtonMail Bridge loopback defaults.
const DEFAULT_IMAP_HOST = "127.0.0.1";
const DEFAULT_IMAP_PORT = 1143;
const DEFAULT_SMTP_HOST = "127.0.0.1";
const DEFAULT_SMTP_PORT = 1025;
const DEFAULT_MAILBOX = "INBOX";

function envStr(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
}

function envelopeFromImap(env: FetchMessageObject["envelope"]): MailEnvelope {
  if (env === undefined) {
    return {};
  }
  const toAddr = (a: { name?: string; address?: string }): { name?: string; address?: string } => {
    const out: { name?: string; address?: string } = {};
    if (a.name !== undefined) {
      out.name = a.name;
    }
    if (a.address !== undefined) {
      out.address = a.address;
    }
    return out;
  };
  return {
    date: env.date ?? null,
    subject: env.subject ?? null,
    messageId: env.messageId ?? null,
    from: (env.from ?? []).map(toAddr),
    to: (env.to ?? []).map(toAddr),
    cc: (env.cc ?? []).map(toAddr),
  };
}

function toMessageMeta(
  msg: FetchMessageObject,
  mailbox: string,
  uidValidity: string | null,
): MailMessageMeta {
  const structure = (msg.bodyStructure ?? null) as BodyStructureNode | null;
  const partKey = findTextPlainPart(structure);
  return {
    uid: msg.uid,
    mailbox,
    uidValidity,
    envelope: envelopeFromImap(msg.envelope),
    attachments: extractAttachments(structure),
    preview: previewFromParts(msg.bodyParts, partKey),
  };
}

function previewFetchQuery(): FetchQueryObject {
  return {
    uid: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    bodyParts: [
      { key: "1", start: 0, maxLength: PREVIEW_FETCH_BYTES },
      { key: "TEXT", start: 0, maxLength: PREVIEW_FETCH_BYTES },
    ],
  };
}

/**
 * Real IMAP client over imapflow, configured for ProtonMail Bridge: a loopback
 * STARTTLS endpoint with a Bridge-generated self-signed certificate, so
 * `secure: false` + `tls.rejectUnauthorized: false` (the connection never
 * leaves 127.0.0.1).
 */
class BridgeImapClient implements MailClient {
  private readonly config: { host: string; port: number; user: string; pass: string };

  constructor() {
    this.config = {
      host: envStr("PROTONMAIL_HOST", DEFAULT_IMAP_HOST),
      port: envInt("PROTONMAIL_PORT", DEFAULT_IMAP_PORT),
      user: requireProcessEnv("PROTONMAIL_USERNAME"),
      pass: requireProcessEnv("PROTONMAIL_PASSWORD"),
    };
  }

  private newClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: false,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
      // ProtonMail Bridge listens on localhost with a self-signed certificate;
      // disabling chain verification is required and safe for the loopback bridge.
      tls: { rejectUnauthorized: false },
    });
  }

  private async withMailbox<T>(
    mailbox: string,
    fn: (client: ImapFlow, uidValidity: string | null) => Promise<T>,
  ): Promise<T> {
    const client = this.newClient();
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const mb = client.mailbox;
      const uidValidity = mb === false ? null : String(mb.uidValidity);
      return await fn(client, uidValidity);
    } finally {
      lock.release();
      await client.logout();
    }
  }

  async list(options: MailListOptions): Promise<MailMessageMeta[]> {
    const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
    const limit = clampLimit(options.limit);
    return this.withMailbox(mailbox, async (client, uidValidity) => {
      const out: MailMessageMeta[] = [];
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) {
        return out;
      }
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;
      for await (const msg of client.fetch(range, previewFetchQuery())) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }

  async get(uid: number, mailbox?: string): Promise<MailMessageMeta | null> {
    const box = mailbox ?? DEFAULT_MAILBOX;
    return this.withMailbox(box, async (client, uidValidity) => {
      const msg = await client.fetchOne(String(uid), previewFetchQuery(), { uid: true });
      return msg === false ? null : toMessageMeta(msg, box, uidValidity);
    });
  }

  async search(options: MailSearchOptions): Promise<MailMessageMeta[]> {
    const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
    const limit = clampLimit(options.limit);
    const q = options.query;
    return this.withMailbox(mailbox, async (client, uidValidity) => {
      const uids = await client.search(
        { or: [{ subject: q }, { from: q }, { to: q }] },
        { uid: true },
      );
      if (uids === false || uids.length === 0) {
        return [];
      }
      const picked = uids.slice(-limit).sort((a, b) => b - a);
      const out: MailMessageMeta[] = [];
      for await (const msg of client.fetch(picked, previewFetchQuery(), { uid: true })) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }
}

/** Real SMTP mailer over nodemailer, configured for the ProtonMail Bridge relay. */
class BridgeMailer implements SmtpMailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor() {
    const host = envStr("PROTONMAIL_SMTP_HOST", DEFAULT_SMTP_HOST);
    const port = envInt("PROTONMAIL_SMTP_PORT", DEFAULT_SMTP_PORT);
    const user = requireProcessEnv("PROTONMAIL_SMTP_USERNAME");
    const pass = requireProcessEnv("PROTONMAIL_SMTP_PASSWORD");
    this.from = user;
    this.transport = createTransport({
      host,
      port,
      secure: false,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
    });
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
      ...(input.cc === undefined ? {} : { cc: input.cc }),
      ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
    });
    return {
      messageId: info.messageId ?? null,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }
}

const server = new McpServer({ name: "nimbus-protonmail", version: "0.1.0" });
registerProtonmailTools(server, new BridgeImapClient(), new BridgeMailer());

await server.connect(new StdioServerTransport());
