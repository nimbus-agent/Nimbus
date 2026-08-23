import type { WriteToolRegistrar } from "./consent-kit.ts";
/**
 * Shared tool-layer helpers for the IMAP/JMAP email connectors (imap, protonmail).
 * Extracted to eliminate byte-identical duplication in tools.ts across those two
 * connectors. FastMail (JMAP) uses a different view shape (id vs uid, no mailbox
 * field) and different arg schemas — its view transformer stays local.
 *
 * Scope: Zod arg schemas, the shared message view transformer, and the shared
 * `envInt` + `previewFromParts` server-layer helpers. Class bodies and
 * connector-specific envelope/meta mappers are deliberately NOT extracted here
 * (they implement different local interfaces and are out of scope per the dedup
 * brief).
 */

import { z } from "zod";

import { headerLine } from "./header-safe.ts";
import { capPreview, clampLimit } from "./imap-mail-core.ts";
import { createRegisterSimpleTool, type McpListResult, mcpJsonResult } from "./mcp-tool-kit.ts";

// ---------------------------------------------------------------------------
// Shared Zod arg schemas (byte-identical across imap + protonmail tools.ts)
// ---------------------------------------------------------------------------

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
  to: headerLine({ min: 1 }),
  subject: headerLine({ min: 1, max: 998 }),
  body: z.string().max(1_000_000),
  cc: headerLine().optional(),
  bcc: headerLine().optional(),
});

/** Shared Zod schemas for the IMAP/protonmail tool arg payloads. */
export const emailToolSchemas = {
  listArgs,
  getArgs,
  searchArgs,
  sendArgs,
} as const;

// ---------------------------------------------------------------------------
// Shared view transformer (imap + protonmail tools.ts — viewMessage)
// ---------------------------------------------------------------------------

/**
 * The minimal shape that `viewEmailMessage` reads from a message meta object.
 * imap's `ImapMessageMeta` and protonmail's `MailMessageMeta` both satisfy this.
 */
export interface EmailMessageMeta {
  readonly uid: number;
  readonly mailbox: string;
  readonly uidValidity: string | null;
  readonly envelope: {
    readonly date?: Date | string | null;
    readonly subject?: string | null;
    readonly messageId?: string | null;
    readonly from?: readonly { readonly name?: string; readonly address?: string }[];
    readonly to?: readonly { readonly name?: string; readonly address?: string }[];
    readonly cc?: readonly { readonly name?: string; readonly address?: string }[];
  };
  readonly attachments: readonly {
    readonly filename: string | null;
    readonly sizeBytes: number | null;
    readonly mimeType: string | null;
  }[];
  readonly preview: string;
}

/**
 * Reduce an {@link EmailMessageMeta} to a JSON-safe view. Returns HEADERS,
 * attachment METADATA (filename/size/mimetype), and the capped preview — never
 * attachment bytes or a full body. Addresses are formatted by the caller-supplied
 * `formatAddr` so each connector can use its own local `formatAddress` helper.
 */
export function viewEmailMessage(
  m: EmailMessageMeta,
  formatAddr: (a: { readonly name?: string; readonly address?: string }) => string,
): Record<string, unknown> {
  const env = m.envelope;
  return {
    uid: m.uid,
    mailbox: m.mailbox,
    uidValidity: m.uidValidity,
    messageId: env.messageId ?? null,
    subject: env.subject ?? null,
    date: env.date instanceof Date ? env.date.toISOString() : (env.date ?? null),
    from: (env.from ?? []).map(formatAddr),
    to: (env.to ?? []).map(formatAddr),
    cc: (env.cc ?? []).map(formatAddr),
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      mimeType: a.mimeType,
    })),
    preview: m.preview,
  };
}

// ---------------------------------------------------------------------------
// Shared server-layer helpers (server.ts — envInt, previewFromParts)
// ---------------------------------------------------------------------------

/**
 * Parse an environment variable as an integer in the range [1, 65535]. Returns
 * `fallback` if the variable is absent, empty, non-numeric, or out of range.
 * Byte-identical to the `envInt` helper in imap/server.ts and protonmail/server.ts.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : fallback;
}

/**
 * Extract and cap a plain-text body preview from the map of IMAP body parts
 * fetched by imapflow. Looks up part keys `partKey → "1" → "TEXT"` in order.
 * Returns an empty string when nothing is found. Byte-equivalent to the
 * `previewFromParts` helpers in imap/server.ts and protonmail/server.ts.
 */
export function previewFromParts(parts: Map<string, Buffer> | undefined, partKey: string): string {
  if (parts === undefined) {
    return "";
  }
  const buf = parts.get(partKey) ?? parts.get("1") ?? parts.get("TEXT");
  if (buf === undefined) {
    return "";
  }
  return capPreview(buf.toString("utf8"));
}

// ---------------------------------------------------------------------------
// Shared tool-registration factory (imap + protonmail tools.ts — the 4 blocks)
// ---------------------------------------------------------------------------

/** Read surface the email tool factory depends on (imap's ImapClient / protonmail's MailClient both satisfy it). */
export interface EmailReadClient {
  list(options: { mailbox?: string; limit?: number }): Promise<EmailMessageMeta[]>;
  get(uid: number, mailbox?: string): Promise<EmailMessageMeta | null>;
  search(options: { query: string; mailbox?: string; limit?: number }): Promise<EmailMessageMeta[]>;
}

/** Send surface the email tool factory depends on (imap's/protonmail's SmtpMailer satisfy it). */
export interface EmailSendMailer {
  send(input: { to: string; subject: string; body: string; cc?: string; bcc?: string }): Promise<{
    messageId: string | null;
    accepted: readonly string[];
    rejected: readonly string[];
  }>;
}

/** The four tool descriptions, supplied verbatim by each connector. */
export interface EmailToolDescriptions {
  readonly list: string;
  readonly get: string;
  readonly search: string;
  readonly send: string;
}

/**
 * Register the 4 email tools (`<prefix>_list|_get|_search|_mail_send`) onto an
 * MCP server. The IMAP client + SMTP mailer are injected so tests exercise the
 * tool surface without opening sockets. Byte-equivalent to the hand-written
 * `registerImapTools` / `registerProtonmailTools` bodies it replaces — the tool
 * names (via `toolPrefix`) and descriptions are the only per-connector inputs.
 */
export function registerEmailConnectorTools(opts: {
  server: { tool: (...args: never) => unknown };
  toolPrefix: string;
  descriptions: EmailToolDescriptions;
  client: EmailReadClient;
  mailer: EmailSendMailer;
  formatAddr: (a: { readonly name?: string; readonly address?: string }) => string;
  /**
   * The connector's write registrar, for `<prefix>_mail_send`.
   *
   * Passed IN rather than built here on purpose: `standaloneEligibility` reads a connector's own
   * `server.ts`/`tools.ts` to decide whether its mutations are gated, and a registrar constructed
   * inside this shared module would be invisible there — the connector would be refused despite
   * being hardened. Requiring it also means a new email connector cannot forget it.
   */
  registerWriteTool: WriteToolRegistrar;
}): void {
  const { server, toolPrefix, descriptions, client, mailer, formatAddr, registerWriteTool } = opts;
  const registerSimpleTool = createRegisterSimpleTool(server);
  const { listArgs, getArgs, searchArgs, sendArgs } = emailToolSchemas;

  registerSimpleTool(
    `${toolPrefix}_list`,
    descriptions.list,
    listArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = listArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const o: { mailbox?: string; limit?: number } = {};
      if (parsed.data.mailbox !== undefined) {
        o.mailbox = parsed.data.mailbox;
      }
      o.limit = clampLimit(parsed.data.limit);
      const items = await client.list(o);
      return mcpJsonResult({ items: items.map((m) => viewEmailMessage(m, formatAddr)) });
    },
  );

  registerSimpleTool(
    `${toolPrefix}_get`,
    descriptions.get,
    getArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = getArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const m = await client.get(parsed.data.uid, parsed.data.mailbox);
      return mcpJsonResult(m === null ? { item: null } : { item: viewEmailMessage(m, formatAddr) });
    },
  );

  registerSimpleTool(
    `${toolPrefix}_search`,
    descriptions.search,
    searchArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = searchArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const o: { query: string; mailbox?: string; limit?: number } = {
        query: parsed.data.query,
        limit: clampLimit(parsed.data.limit),
      };
      if (parsed.data.mailbox !== undefined) {
        o.mailbox = parsed.data.mailbox;
      }
      const items = await client.search(o);
      return mcpJsonResult({ matches: items.map((m) => viewEmailMessage(m, formatAddr)) });
    },
  );

  registerWriteTool(
    `${toolPrefix}_mail_send`,
    {
      mutates: `${toolPrefix}.mail.send`,
      // A sent mail cannot be recalled and nothing remains to query, so the recipient and
      // subject ARE the pre-state.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ to: p.to, subject: p.subject }),
      scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }),
    },
    descriptions.send,
    sendArgs,
    async (parsedData): Promise<McpListResult> => {
      const parsed = { success: true as const, data: parsedData };
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
