/**
 * Agent-written text on the Captures page is shown with every character that renders as nothing
 * (or rewrites the rendering of what follows) made VISIBLE as `\u{XXXX}`. React already escapes
 * markup; this closes the other half: a right-to-left override or a zero-width space would make the
 * text the owner reads differ from the text that is stored (Trojan Source, CVE-2021-42574).
 *
 * The table is the gateway's `mcp-sink/invisible-text.ts` FORMAT_INVISIBLE_RANGES (the desktop may
 * not import gateway source, so it is copied, and the copy must cover everything that one does),
 * plus the C0 controls except TAB and LF, which keep their layout meaning in a `<pre>`. Written as
 * NUMBERS for the reason the gateway file gives: an invisible character in this list is exactly what
 * a reviewer cannot see. Each entry is an inclusive [first, last] code point.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

function isInvisible(cp: number): boolean {
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** `s` with each invisible/bidi/control code point replaced by `\u{XXXX}` (uppercase hex). */
export function showInvisible(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isInvisible(cp) ? `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}` : ch;
  }
  return out;
}
