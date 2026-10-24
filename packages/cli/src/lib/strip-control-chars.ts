/**
 * Drops C0/C1 control characters and DEL. The gateway already reports an invalid `active.json`
 * entry by position only, but this CLI may talk to an older or another gateway, and a raw escape
 * sequence printed to the terminal is never what the owner should see.
 */
export function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}
