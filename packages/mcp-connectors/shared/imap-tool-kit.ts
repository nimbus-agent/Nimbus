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

import { capPreview } from "./imap-mail-core.ts";

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
  to: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
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
