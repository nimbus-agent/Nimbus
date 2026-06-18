/**
 * JMAP connector core — transport-agnostic logic for the Fastmail read tools
 * (`fastmail_list`, `fastmail_get`, `fastmail_search`) and the HITL-gated send
 * tool (`fastmail_mail_send`).
 *
 * HARD SCOPE CONSTRAINT (security): this connector indexes/returns HEADERS + a
 * short capped plain-text body PREVIEW + attachment METADATA only. The JMAP
 * `Email/get` calls request `maxBodyValueBytes` (the server truncates the body
 * value, so a full body never crosses the wire) and store only the `attachments`
 * body-part METADATA (name/size/type) — the `blobId` download URL is NEVER
 * dereferenced. There is no surface to fetch attachment bytes or a full body.
 *
 * The JMAP transport (real over `fetch`) is injected so tests never open a socket.
 *
 * Pure JMAP parsing and request-building is provided by `@nimbus-dev/sdk`
 * (gateway ↔ mcp boundary — neither package can import the other).
 */

import type { JmapEmailView } from "@nimbus-dev/sdk";

export {
  asRecord,
  asString,
  buildGetRequest,
  buildListRequest,
  buildSearchRequest,
  CORE_CAPABILITY,
  capPreview,
  EMAIL_PROPERTIES,
  extractAttachments,
  extractEmailList,
  formatAddress,
  formatAddresses,
  type JmapAttachmentMeta,
  type JmapEmailView,
  type JmapSession,
  MAIL_CAPABILITY,
  MAX_BODY_VALUE_BYTES,
  methodResponseArgs,
  PREVIEW_MAX_CHARS,
  parseSession,
  previewFor,
  SUBMISSION_CAPABILITY,
  validateApiUrl,
  viewEmail,
} from "@nimbus-dev/sdk";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Outgoing message for the SMTP/JMAP submission send tool. */
export interface SendMailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}

export interface SendMailResult {
  readonly emailId: string | null;
  readonly submissionId: string | null;
}

/**
 * Minimal Fastmail/JMAP client surface the tools depend on. Implemented for real
 * by the fetch adapter in `server.ts` and by a fake in tests. Deliberately
 * exposes ONLY header/attachment-metadata + capped-preview reads + a send.
 */
export interface JmapClient {
  list(limit: number): Promise<JmapEmailView[]>;
  get(id: string): Promise<JmapEmailView | null>;
  search(query: string, limit: number): Promise<JmapEmailView[]>;
  send(input: SendMailInput): Promise<SendMailResult>;
}

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  const n = Math.trunc(limit);
  if (n < 1) {
    return 1;
  }
  return Math.min(n, MAX_LIST_LIMIT);
}
