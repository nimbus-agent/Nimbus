import type { MappedRow } from "./mapped-row.ts";

/**
 * One attachment's METADATA — name, size, mimetype. NEVER the bytes. This is the
 * only attachment shape that ever enters the local index. Derived from the JMAP
 * `Email/get` `attachments` body-part list (we store name/size/type and never
 * dereference the `blobId` download URL).
 */
export interface FastmailAttachmentMeta {
  readonly name: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

/**
 * The header + attachment-metadata + capped-preview view of one Fastmail email,
 * normalized from a JMAP `Email/get` response. The gateway cannot import the
 * connector package, so this mirrors the normalized shape.
 *
 * NOTE: there is deliberately NO field for a full body or attachment content —
 * the JMAP fetch caps body values server-side (`maxBodyValueBytes`) and never
 * downloads an attachment blob, so the mapper has nothing to leak.
 */
export interface FastmailEmailInput {
  /** JMAP email id — stable and unique per account. */
  readonly id: string;
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  /** JMAP `receivedAt` (UTCDate / ISO-8601). */
  readonly receivedAt: string | null;
  readonly attachments: readonly FastmailAttachmentMeta[];
  readonly preview: string;
}

export interface FastmailMappingContext {
  readonly syncedAt: number;
}

export type FastmailMappedRow = MappedRow<"fastmail", "email">;

const TITLE_MAX = 256;
/**
 * Hard cap on the indexed body preview. The JMAP fetch already truncates body
 * values server-side; this is a defence-in-depth ceiling in the mapper.
 */
const PREVIEW_MAX = 2000;

const SERVICE = "fastmail" as const;
const TYPE = "email" as const;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseDateMs(date: string | null): number | null {
  if (date !== null && date.trim() !== "") {
    const ms = Date.parse(date);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Stable external id for an email. Prefers the RFC message-id (stable across
 * folder moves); falls back to the JMAP email `id` (stable + unique per
 * account). NEVER a random uuid.
 */
export function fastmailExternalId(input: { messageId: string | null; id: string }): string {
  const mid = input.messageId?.trim();
  if (mid !== undefined && mid !== "") {
    return mid;
  }
  return input.id;
}

/**
 * Pure mapper: a normalized JMAP email view → a `fastmail:email` IndexedItem.
 * Stores HEADERS, a capped plain-text PREVIEW, and attachment METADATA
 * (name/size/mimetype) ONLY. NEVER attachment bytes and NEVER a full body.
 * Returns null when the email carries no id basis.
 */
export function mapFastmailEmailToItem(
  input: FastmailEmailInput,
  ctx: FastmailMappingContext,
): FastmailMappedRow | null {
  const id = input.id?.trim() ?? "";
  if (id === "" && (input.messageId === null || input.messageId.trim() === "")) {
    return null;
  }

  const externalId = fastmailExternalId({ messageId: input.messageId, id });

  const subject = input.subject?.trim() ?? "";
  const title = clamp(subject === "" ? "(no subject)" : subject, TITLE_MAX);
  const bodyPreview = clamp(input.preview ?? "", PREVIEW_MAX);
  const modifiedAt = parseDateMs(input.receivedAt) ?? ctx.syncedAt;

  // Attachment METADATA only — name, size, mimetype. No content field exists.
  const attachments = input.attachments.map((a) => ({
    filename: a.name,
    sizeBytes: a.sizeBytes,
    mimeType: a.mimeType,
  }));

  const participants = [...input.from, ...input.to, ...(input.cc ?? [])];

  const metadata: Record<string, unknown> = {
    jmapId: id,
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
