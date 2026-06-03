/**
 * IMAP/SMTP connector core — transport-agnostic logic for the read tools
 * (`imap_list`, `imap_get`, `imap_search`) and the HITL-gated send tool
 * (`imap_mail_send`).
 *
 * HARD SCOPE CONSTRAINT (security): this connector indexes HEADERS + a short
 * capped plain-text body PREVIEW + attachment METADATA only. It NEVER downloads
 * or parses attachment bytes and never fetches the full message body. The IMAP
 * client interface below deliberately exposes only `envelope` + `bodyStructure`
 * (headers / attachment metadata) and a single truncated text body part for the
 * preview — there is no surface to request `BODY[]` or an attachment part.
 *
 * The IMAP client and SMTP mailer are injected so tests never open real sockets.
 */

/** Max characters of the plain-text body preview that is ever indexed/returned. */
export const PREVIEW_MAX_CHARS = 2000;
/** Max bytes of the text/plain body part fetched for the preview (~2 KB). */
export const PREVIEW_FETCH_BYTES = 2048;

/** One parsed address (name optional). */
export interface ImapAddress {
  readonly name?: string;
  readonly address?: string;
}

/** Message ENVELOPE — RFC 2822 header fields only. */
export interface ImapEnvelope {
  readonly date?: Date | string | null;
  readonly subject?: string | null;
  readonly messageId?: string | null;
  readonly from?: readonly ImapAddress[];
  readonly to?: readonly ImapAddress[];
  readonly cc?: readonly ImapAddress[];
}

/**
 * Attachment METADATA only — filename, size, mimetype. NEVER the bytes.
 * Derived from BODYSTRUCTURE.
 */
export interface ImapAttachmentMeta {
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

/**
 * A single mailbox message reduced to header + attachment-metadata + a capped
 * text preview. This is the ONLY shape the connector ever materializes; it has
 * no field that could carry attachment content or a full body.
 */
export interface ImapMessageMeta {
  readonly uid: number;
  readonly mailbox: string;
  readonly uidValidity: string | null;
  readonly envelope: ImapEnvelope;
  readonly attachments: readonly ImapAttachmentMeta[];
  /** Plain-text body preview, already capped to {@link PREVIEW_MAX_CHARS}. */
  readonly preview: string;
}

/** Listing options. */
export interface ImapListOptions {
  readonly mailbox?: string;
  readonly limit?: number;
}

/** Search options — searches header/envelope fields, never document/body content scans. */
export interface ImapSearchOptions {
  readonly query: string;
  readonly mailbox?: string;
  readonly limit?: number;
}

/**
 * Minimal IMAP client surface the connector depends on. Implemented for real by
 * the imapflow adapter in `server.ts` and by a fake in tests. Deliberately
 * exposes ONLY header/attachment-metadata + capped-preview reads.
 */
export interface ImapClient {
  /** List the most recent messages (header + attachment metadata + preview). */
  list(options: ImapListOptions): Promise<ImapMessageMeta[]>;
  /** Fetch one message's header + attachment metadata + preview by uid. */
  get(uid: number, mailbox?: string): Promise<ImapMessageMeta | null>;
  /** Search by subject/from/to substring; returns matching message metas. */
  search(options: ImapSearchOptions): Promise<ImapMessageMeta[]>;
}

/** Outgoing message for the SMTP send tool. */
export interface SendMailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}

/** Result of a send (message id assigned by the SMTP server, if any). */
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

/**
 * Cap a body preview to {@link PREVIEW_MAX_CHARS}. Normalizes CRLF and collapses
 * whitespace/blank-line runs so the preview stays compact; never lengthens the
 * input.
 */
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
export function formatAddress(a: ImapAddress): string {
  const addr = a.address ?? "";
  if (a.name !== undefined && a.name !== "") {
    return addr === "" ? a.name : `${a.name} <${addr}>`;
  }
  return addr;
}
