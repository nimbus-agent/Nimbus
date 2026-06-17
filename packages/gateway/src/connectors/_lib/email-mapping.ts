/**
 * Pure email-mapping helpers shared across the imap, protonmail, and fastmail
 * connectors. Extracted to avoid duplication — behaviour is identical in all three.
 */

/**
 * Clamp a string to `max` characters, appending a Unicode ellipsis if truncated.
 */
export function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Parse a date value (IMAP/JMAP) to epoch milliseconds, or null if unparseable.
 * - Finite number → returned as-is.
 * - Non-empty string → `Date.parse`; null if the result is not finite.
 * - null / empty / whitespace-only → null.
 */
export function parseDateMs(date: string | number | null): number | null {
  if (typeof date === "number" && Number.isFinite(date)) {
    return date;
  }
  if (typeof date === "string" && date.trim() !== "") {
    const ms = Date.parse(date);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
