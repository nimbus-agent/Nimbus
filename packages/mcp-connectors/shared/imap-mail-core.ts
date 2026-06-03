/**
 * Pure, transport-agnostic helpers shared by the IMAP-based mail connectors
 * (imap, protonmail-via-Bridge). ProtonMail Bridge exposes a standard IMAP/SMTP
 * interface, so both connectors share the same preview-capping, limit-clamping,
 * and address-formatting logic. No external deps; never touches message bodies
 * or attachment bytes.
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
  return Math.min(n, MAX_LIST_LIMIT);
}

/**
 * Cap a body preview to {@link PREVIEW_MAX_CHARS}. Normalizes CRLF and collapses
 * whitespace/blank-line runs so the preview stays compact; never lengthens the
 * input.
 */
export function capPreview(text: string): string {
  const normalized = text
    .replaceAll("\r\n", "\n")
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
