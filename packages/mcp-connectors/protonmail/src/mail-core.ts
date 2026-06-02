/**
 * ProtonMail (via ProtonMail Bridge) connector core — transport-agnostic logic
 * for the read tools (`protonmail_list`, `protonmail_get`, `protonmail_search`)
 * and the HITL-gated send tool (`protonmail_mail_send`). ProtonMail Bridge
 * exposes a standard IMAP/SMTP interface on the loopback interface, so this is
 * the same shape as the generic IMAP connector core.
 *
 * HARD SCOPE CONSTRAINT (security): this connector indexes HEADERS + a short
 * capped plain-text body PREVIEW + attachment METADATA only. It NEVER downloads
 * or parses attachment bytes and never fetches the full message body.
 *
 * The IMAP client and SMTP mailer are injected so tests never open real sockets.
 */

/** Max characters of the plain-text body preview that is ever indexed/returned. */
export const PREVIEW_MAX_CHARS = 2000;
/** Max bytes of the text/plain body part fetched for the preview (~2 KB). */
export const PREVIEW_FETCH_BYTES = 2048;

/** One parsed address (name optional). */
export interface MailAddress {
  readonly name?: string;
  readonly address?: string;
}

/** Message ENVELOPE — RFC 2822 header fields only. */
export interface MailEnvelope {
  readonly date?: Date | string | null;
  readonly subject?: string | null;
  readonly messageId?: string | null;
  readonly from?: readonly MailAddress[];
  readonly to?: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
}

/** Attachment METADATA only — filename, size, mimetype. NEVER the bytes. */
export interface MailAttachmentMeta {
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

/**
 * A single mailbox message reduced to header + attachment-metadata + a capped
 * text preview. This is the ONLY shape the connector ever materializes.
 */
export interface MailMessageMeta {
  readonly uid: number;
  readonly mailbox: string;
  readonly uidValidity: string | null;
  readonly envelope: MailEnvelope;
  readonly attachments: readonly MailAttachmentMeta[];
  /** Plain-text body preview, already capped to {@link PREVIEW_MAX_CHARS}. */
  readonly preview: string;
}

export interface MailListOptions {
  readonly mailbox?: string;
  readonly limit?: number;
}

export interface MailSearchOptions {
  readonly query: string;
  readonly mailbox?: string;
  readonly limit?: number;
}

/**
 * Minimal IMAP client surface the connector depends on. Implemented for real by
 * the imapflow adapter in `server.ts` and by a fake in tests.
 */
export interface MailClient {
  list(options: MailListOptions): Promise<MailMessageMeta[]>;
  get(uid: number, mailbox?: string): Promise<MailMessageMeta | null>;
  search(options: MailSearchOptions): Promise<MailMessageMeta[]>;
}

/** Outgoing message for the SMTP send tool. */
export interface SendMailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}

export interface SendMailResult {
  readonly messageId: string | null;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

/** Minimal SMTP mailer surface; implemented for real over nodemailer. */
export interface SmtpMailer {
  send(input: SendMailInput): Promise<SendMailResult>;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  const n = Math.trunc(limit);
  if (n < 1) {
    return 1;
  }
  return n > MAX_LIST_LIMIT ? MAX_LIST_LIMIT : n;
}

/** Cap a body preview to {@link PREVIEW_MAX_CHARS}, normalizing whitespace. */
export function capPreview(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS)
    : normalized;
}

/** Format one address as `Name <addr>` / `<addr>` for envelope display. */
export function formatAddress(a: MailAddress): string {
  const addr = a.address ?? "";
  if (a.name !== undefined && a.name !== "") {
    return addr === "" ? a.name : `${a.name} <${addr}>`;
  }
  return addr;
}
