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

import type { MailAddress } from "../../shared/imap-mail-core.ts";

export {
  capPreview,
  clampLimit,
  formatAddress,
  PREVIEW_FETCH_BYTES,
  PREVIEW_MAX_CHARS,
} from "../../shared/imap-mail-core.ts";
export type { MailAddress };

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
