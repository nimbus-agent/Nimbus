// packages/gateway/src/connectors/connector-writes/sanitise.ts
// The consent preview's text sanitiser, moved out of `preview.ts` unchanged so `diff.ts` can use it
// without importing the preview builder (which imports the diff types). `preview.ts` re-exports it.

/**
 * Replaces every character that could repaint, retitle, forge or hide text in the owner's prompt
 * with a visible escape `\u{XXXX}` (uppercase hex, at least 4 digits), so the owner sees exactly
 * what will be sent and two different keys cannot collapse into one. Ranges:
 *  - U+0000-U+0008, U+000B-U+001F: C0 controls except TAB (U+0009) and LF (U+000A). This includes
 *    CR (U+000D), BEL and every ESC (U+001B): no CSI, OSC (titles, hyperlinks, clipboard), DCS or
 *    two-byte escape (RIS, reverse line feed, cursor save) can act.
 *  - U+007F-U+009F: DEL and the C1 range (8-bit CSI/OSC introducers).
 *  - U+2028, U+2029: Unicode line and paragraph separators.
 *  - U+202A-U+202E, U+2066-U+2069: bidi embeddings, overrides and isolates.
 *  - U+200B-U+200F: zero-width space/joiners and the LRM/RLM marks; U+061C: Arabic letter mark;
 *    U+2060-U+2064: word joiner and invisible operators; U+180E: Mongolian vowel separator;
 *    U+FEFF: BOM / zero-width no-break space.
 *  - U+E0000-U+E007F: the tag block (invisible "ASCII smuggling" characters).
 * Tab and newline are kept here; the CLI renderer shows them as `\t` and `\n`. A literal backslash
 * in the input is left as is, so `\u{...}` in the output is ambiguous only with a literal input
 * backslash-u; that is accepted.
 */
function isUnsafeCodePoint(c: number): boolean {
  return (
    c <= 0x08 ||
    (c >= 0x0b && c <= 0x1f) || // C0 except TAB and LF (includes CR, BEL, ESC)
    (c >= 0x7f && c <= 0x9f) || // DEL and C1
    (c >= 0x200b && c <= 0x200f) || // zero-width, LRM, RLM
    c === 0x061c ||
    c === 0x2028 ||
    c === 0x2029 || // line / paragraph separators
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings and overrides
    (c >= 0x2060 && c <= 0x2064) || // word joiner, invisible operators
    (c >= 0x2066 && c <= 0x2069) || // bidi isolates
    c === 0x180e ||
    c === 0xfeff ||
    (c >= 0xe0000 && c <= 0xe007f) // tag block
  );
}

export function sanitisePreviewText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += isUnsafeCodePoint(c)
      ? String.raw`\u{${c.toString(16).toUpperCase().padStart(4, "0")}}`
      : ch;
  }
  return out;
}

/**
 * Characters {@link escapeDiffText} always escapes: every control (Cc), format (Cf: bidi, zero-width,
 * soft hyphen, the tag block, interlinear annotation, ...), line and paragraph separator (Zl, Zp),
 * surrogate (Cs), the variation selectors and supplement, and the blank-looking letters (combining
 * grapheme joiner, Hangul fillers, braille blank), and the backslash itself. One linear pass.
 * The source holds escapes, never the invisible characters themselves.
 */
const DIFF_ESCAPED =
  /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u3164\uFFA0\u2800]|\u034F|\u115F|\u1160|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;

/**
 * The diff's text escaper (D1c). Unlike {@link sanitisePreviewText} it is INJECTIVE: a literal
 * backslash is shown `\\`, so a real character shown `\u{XXXX}` (a tab is `\u{0009}`, a CR
 * `\u{000D}`) can never look like the same characters typed literally, and it escapes every
 * invisible or format character, not the shorter list of the field previews. Only LF is kept (a
 * diff line never holds one).
 */
export function escapeDiffText(s: string): string {
  return s.replace(DIFF_ESCAPED, (ch) => {
    if (ch === "\n") return ch;
    if (ch === "\\") return "\\\\";
    const c = ch.codePointAt(0) ?? 0;
    return String.raw`\u{${c.toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}
