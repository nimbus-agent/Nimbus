import { clamp, parseDateMs } from "./_lib/email-mapping.ts";
import { type ImapMessageInput, imapExternalId } from "./imap-email-mapping.ts";
import type { MappedRow } from "./mapped-row.ts";

/**
 * ProtonMail (via ProtonMail Bridge) speaks plain IMAP/SMTP on the loopback
 * interface, so it reuses the IMAP message-input shape ({@link ImapMessageInput})
 * and the {@link imapExternalId} helper — the only difference from `imap:email`
 * is the service literal. HEADERS + capped PREVIEW + attachment METADATA only;
 * NEVER attachment bytes or a full body.
 */
export type ProtonmailMappedRow = MappedRow<"protonmail", "email">;
export type { ImapMessageInput as ProtonmailMessageInput } from "./imap-email-mapping.ts";

export interface ProtonmailMappingContext {
  readonly syncedAt: number;
}

const TITLE_MAX = 256;
const PREVIEW_MAX = 2000;
const SERVICE = "protonmail" as const;
const TYPE = "email" as const;

/**
 * Pure mapper: a ProtonMail-Bridge IMAP message view → a `protonmail:email`
 * IndexedItem. Stores HEADERS, a capped plain-text PREVIEW, and attachment
 * METADATA (filename/size/mimetype) ONLY. Returns null when the message carries
 * no id basis.
 */
export function mapProtonmailEmailToItem(
  input: ImapMessageInput,
  ctx: ProtonmailMappingContext,
): ProtonmailMappedRow | null {
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
