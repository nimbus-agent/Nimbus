import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type FetchMessageObject, type FetchQueryObject, ImapFlow } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import {
  type BodyStructureNode,
  extractAttachments,
  findTextPlainPart,
} from "../../shared/imap-bodystructure.ts";
import { requireProcessEnv } from "../../shared/mcp-tool-kit.ts";
import {
  capPreview,
  clampLimit,
  type ImapAddress,
  type ImapClient,
  type ImapEnvelope,
  type ImapListOptions,
  type ImapMessageMeta,
  type ImapSearchOptions,
  PREVIEW_FETCH_BYTES,
  type SendMailInput,
  type SendMailResult,
  type SmtpMailer,
} from "./imap-core.ts";
import { registerImapTools } from "./tools.ts";

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_MAILBOX = "INBOX";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : fallback;
}

/**
 * Build an {@link ImapAddress} from an imapflow envelope address, omitting
 * `name`/`address` when absent (the interface uses `exactOptionalPropertyTypes`,
 * so an explicit `undefined` is not assignable).
 */
function toImapAddress(a: { name?: string; address?: string }): ImapAddress {
  const out: { name?: string; address?: string } = {};
  if (a.name !== undefined) {
    out.name = a.name;
  }
  if (a.address !== undefined) {
    out.address = a.address;
  }
  return out;
}

function envelopeFromImap(env: FetchMessageObject["envelope"]): ImapEnvelope {
  if (env === undefined) {
    return {};
  }
  return {
    date: env.date ?? null,
    subject: env.subject ?? null,
    messageId: env.messageId ?? null,
    from: (env.from ?? []).map(toImapAddress),
    to: (env.to ?? []).map(toImapAddress),
    cc: (env.cc ?? []).map(toImapAddress),
  };
}

/**
 * Build the truncated plain-text preview from the SINGLE text/plain body part we
 * requested (capped to PREVIEW_FETCH_BYTES at fetch time, then to
 * PREVIEW_MAX_CHARS). We NEVER request `BODY[]` or an attachment part, so this
 * Buffer is at most a couple KB of the text body.
 */
function previewFromParts(parts: Map<string, Buffer> | undefined, partKey: string): string {
  if (parts === undefined) {
    return "";
  }
  const buf = parts.get(partKey) ?? parts.get("1") ?? parts.get("TEXT");
  if (buf === undefined) {
    return "";
  }
  return capPreview(buf.toString("utf8"));
}

function toMessageMeta(
  msg: FetchMessageObject,
  mailbox: string,
  uidValidity: string | null,
): ImapMessageMeta {
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

/**
 * Fetch query that requests ONLY headers + structure + a truncated text body
 * part. There is no `source` / full-body request here by construction.
 */
function previewFetchQuery(): FetchQueryObject {
  return {
    uid: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    // Two candidate text part keys, each capped to PREVIEW_FETCH_BYTES bytes.
    bodyParts: [
      { key: "1", start: 0, maxLength: PREVIEW_FETCH_BYTES },
      { key: "TEXT", start: 0, maxLength: PREVIEW_FETCH_BYTES },
    ],
  };
}

/** Real IMAP client over imapflow. Per-call connect/lock/logout keeps it stateless. */
class ImapFlowClient implements ImapClient {
  private readonly config: {
    host: string;
    port: number;
    user: string;
    pass: string;
  };

  constructor() {
    this.config = {
      host: requireProcessEnv("IMAP_HOST"),
      port: envInt("IMAP_PORT", DEFAULT_IMAP_PORT),
      user: requireProcessEnv("IMAP_USERNAME"),
      pass: requireProcessEnv("IMAP_PASSWORD"),
    };
  }

  private newClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
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

  async list(options: ImapListOptions): Promise<ImapMessageMeta[]> {
    const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
    const limit = clampLimit(options.limit);
    return this.withMailbox(mailbox, async (client, uidValidity) => {
      const out: ImapMessageMeta[] = [];
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
      // Most-recent first.
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }

  async get(uid: number, mailbox?: string): Promise<ImapMessageMeta | null> {
    const box = mailbox ?? DEFAULT_MAILBOX;
    return this.withMailbox(box, async (client, uidValidity) => {
      const msg = await client.fetchOne(String(uid), previewFetchQuery(), { uid: true });
      return msg === false ? null : toMessageMeta(msg, box, uidValidity);
    });
  }

  async search(options: ImapSearchOptions): Promise<ImapMessageMeta[]> {
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
      const out: ImapMessageMeta[] = [];
      for await (const msg of client.fetch(picked, previewFetchQuery(), { uid: true })) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }
}

/** Real SMTP mailer over nodemailer. */
class NodemailerMailer implements SmtpMailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor() {
    const host = requireProcessEnv("IMAP_SMTP_HOST");
    const port = envInt("IMAP_SMTP_PORT", DEFAULT_SMTP_PORT);
    const user = requireProcessEnv("IMAP_SMTP_USERNAME");
    const pass = requireProcessEnv("IMAP_SMTP_PASSWORD");
    this.from = user;
    this.transport = createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
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

const server = new McpServer({ name: "nimbus-imap", version: "0.1.0" });
registerImapTools(
  server,
  new ImapFlowClient(),
  new NodemailerMailer(),
);

await server.connect(new StdioServerTransport());
