import { showInvisible } from "../../lib/escape-invisible";

/**
 * Every gateway string the Incidents page shows as plain text goes through here. A provider-written
 * title or event text may hold a bidirectional override or a zero-width character; `showInvisible`
 * makes each one visible as `\u{XXXX}` and `max` bounds how much one value can take. React already
 * escapes markup, and nothing on this page builds HTML, an anchor or an image from gateway text.
 */
export function safeText(s: unknown, max = 300): string {
  const text = typeof s === "string" ? showInvisible(s) : "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
