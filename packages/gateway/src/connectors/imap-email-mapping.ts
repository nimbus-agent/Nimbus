import type { MappedRow } from "./mapped-row.ts";

/**
 * One attachment's METADATA — filename, size, mimetype. NEVER the bytes. This is
 * the only attachment shape that ever enters the local index.
 */
export interface ImapAttachmentMeta {
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

/**
 * The header + attachment-metadata + capped-preview view of one IMAP message, as
 * produced by the `imap` MCP connector's read tools. The gateway cannot import
 * the connector package, so this mirrors the JSON view shape.
 *
 * NOTE: there is deliberately NO field for attachment content or a full body —
 * the mapper has nothing to leak even if it tried.
 */
export interface ImapMessageInput {
  readonly uid: number;
  readonly mailbox: string;
  readonly uidValidity: string | null;
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly date: string | number | null;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly attachments: readonly ImapAttachmentMeta[];
  readonly preview: string;
}

export interface ImapMappingContext {
  readonly syncedAt: number;
}

export type ImapMappedRow = MappedRow<"imap", "email">;

const TITLE_MAX = 256;
/**
 * Hard cap on the indexed body preview. The connector already caps at ~2000
 * chars; this is a defence-in-depth ceiling in the mapper so a misbehaving
 * connector can never push a large body into the index.
 */
const PREVIEW_MAX = 2000;

const SERVICE = "imap" as const;
const TYPE = "email" as const;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseDateMs(date: string | number | null): number | null {
  if (typeof date === "number" && Number.isFinite(date)) {
    return date;
  }
  if (typeof date === "string" && date.trim() !== "") {
    const ms = Date.parse(date);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Stable external id for a message. Prefers the RFC message-id (stable across
 * mailbox moves); falls back to `<mailbox>:<uidvalidity>:<uid>` (stable while
 * uidvalidity is unchanged). NEVER a random uuid.
 */
export function imapExternalId(input: {
  messageId: string | null;
  mailbox: string;
  uidValidity: string | null;
  uid: number;
}): string {
  const mid = input.messageId?.trim();
  if (mid !== undefined && mid !== "") {
    return mid;
  }
  const uv = input.uidValidity ?? "0";
  return `${input.mailbox}:${uv}:${input.uid}`;
}

/**
 * Pure mapper: an IMAP message header/attachment-metadata/preview view → an
 * `imap:email` IndexedItem. Stores HEADERS, a capped plain-text PREVIEW, and
 * attachment METADATA (filename/size/mimetype) ONLY. NEVER attachment bytes and
 * NEVER a full message body. Returns null when the message carries no id basis.
 */
export function mapImapMessageToItem(
  input: ImapMessageInput,
  ctx: ImapMappingContext,
): ImapMappedRow | null {
  if (
    (input.messageId === null || input.messageId.trim() === "") &&
    (!Number.isFinite(input.uid) || input.uid <= 0)
  ) {
    return null;
  }

  const externalId = imapExternalId({
    messageId: input.messageId,
    mailbox: input.mailbox,
    uidValidity: input.uidValidity,
    uid: input.uid,
  });

  const subject = input.subject?.trim() ?? "";
  const title = clamp(subject === "" ? "(no subject)" : subject, TITLE_MAX);
  const bodyPreview = clamp(input.preview ?? "", PREVIEW_MAX);
  const modifiedAt = parseDateMs(input.date) ?? ctx.syncedAt;

  // Attachment METADATA only — filename, size, mimetype. No content field exists.
  const attachments = input.attachments.map((a) => ({
    filename: a.filename,
    sizeBytes: a.sizeBytes,
    mimeType: a.mimeType,
  }));

  const participants = [...input.from, ...input.to, ...(input.cc ?? [])];

  const metadata: Record<string, unknown> = {
    mailbox: input.mailbox,
    uid: input.uid,
    uidValidity: input.uidValidity,
    messageId: input.messageId,
    from: [...input.from],
    to: [...input.to],
    cc: [...(input.cc ?? [])],
    participants,
    attachments,
    attachmentCount: attachments.length,
  };

  return {
    service: SERVICE,
    type: TYPE,
    externalId,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
