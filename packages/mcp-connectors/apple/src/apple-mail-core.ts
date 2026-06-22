/**
 * Mail-layer re-exports + Drafts-append interface for the iCloud Mail connector.
 *
 * Helpers + client/mailer types come ONLY from the shared connector toolkit
 * (packages/mcp-connectors/shared/*) — NEVER cross-import a sibling connector's
 * src (e.g. ../../imap/src/...): that breaks per-workspace tsc/bundling output.
 *
 * The shared kit already defines the structural client/mailer/message contracts
 * the connector must satisfy (EmailReadClient/EmailSendMailer/EmailMessageMeta).
 */

export {
  capPreview,
  clampLimit,
  formatAddress,
  PREVIEW_FETCH_BYTES,
  PREVIEW_MAX_CHARS,
} from "../../shared/imap-mail-core.ts";

// The shared kit already defines the structural client/mailer/message contracts
// the connector must satisfy (EmailReadClient/EmailSendMailer/EmailMessageMeta).
export type {
  EmailMessageMeta,
  EmailReadClient,
  EmailSendMailer,
} from "../../shared/imap-tool-kit.ts";

export interface DraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}

export interface DraftResult {
  readonly uid: number | null;
  readonly mailbox: string;
}

export interface DraftAppender {
  appendDraft(input: DraftInput): Promise<DraftResult>;
}
