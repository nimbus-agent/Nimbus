import { z } from "zod";

/**
 * Rejects any string containing a carriage return or line feed. CR/LF in an
 * email header field (`To`/`Cc`/`Bcc`/`Subject`/attendee list) is the classic
 * header / recipient-injection vector: a folded line can smuggle extra headers
 * or recipients into the outgoing message. Body text legitimately contains
 * newlines and must NOT use this guard.
 */
const NO_CRLF = /^[^\r\n]*$/;

/**
 * A Zod string constrained to a single header line (no CR/LF), with optional
 * length bounds. Use for every user-supplied field that flows into an email
 * header — `to`, `cc`, `bcc`, `subject`, and comma-separated recipient/attendee
 * lists. The single shared definition keeps the guard consistent across every
 * send/draft connector (imap, protonmail, fastmail, gmail, outlook).
 */
export function headerLine(opts?: { min?: number; max?: number }): z.ZodString {
  let s = z.string().regex(NO_CRLF, "must not contain a line break (CR/LF)");
  if (opts?.min !== undefined) {
    s = s.min(opts.min);
  }
  if (opts?.max !== undefined) {
    s = s.max(opts.max);
  }
  return s;
}
