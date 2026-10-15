/**
 * The ONE code-point table of characters that render as nothing (or rewrite the rendering of what
 * follows) for agent-written text in `mcp-sink/`. `capture-validate.ts` STRIPS them at write time;
 * `capture-act.ts` ESCAPES them visibly in the act door's consent prompt. Keep in step with the
 * CLI's `packages/cli/src/commands/captures-format.ts` UNSAFE_TEXT_RANGES, which strips the same
 * set before display (the CLI cannot import this file: it reaches the gateway over IPC only).
 *
 * C0 controls (U+0000..U+001F) are deliberately NOT in this table: each consumer keeps a different
 * subset (a body keeps \t \n \r; the consent prompt keeps LF), so each composes its own C0 ranges
 * with {@link FORMAT_INVISIBLE_RANGES}.
 *
 * Covers DEL + C1, the soft hyphen, the combining grapheme joiner, the Arabic letter mark, the Hangul
 * fillers, the Khmer inherent vowels, the Mongolian vowel separator, ZWSP..RLM, U+2028..U+202E
 * (line/paragraph separators + bidi embeddings/overrides, CVE-2021-42574), U+2060..U+206F (word
 * joiner, invisible operators, bidi isolates, deprecated format characters), the Hangul filler
 * U+3164, the variation selectors (BMP and supplement), the BOM, the halfwidth Hangul filler, the
 * interlinear annotation characters, and the astral TAG characters, which can spell a whole hidden
 * instruction. NOT U+202F (narrow no-break space): it renders as a space. Homoglyphs are out of
 * reach of any table and remain the stated bound.
 *
 * Written as NUMBERS, never as regex escapes or literals: the repo's format hook can rewrite a `\u`
 * escape in a regex literal into the invisible character itself, and an invisible character in
 * this list is exactly what a reviewer cannot see. Each entry is an inclusive [first, last] code
 * point.
 */
export type CodePointRange = readonly [number, number];

export const FORMAT_INVISIBLE_RANGES: ReadonlyArray<CodePointRange> = [
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

/**
 * A global, code-point (`u`) regex matching any character in `ranges`. One single-range class per
 * alternative, so no class mixes a base character with a combining one. The range ends are inserted
 * as characters at RUNTIME: none of them is `]`, `-`, `^` or a backslash, so each class is literal.
 */
export function rangesRegExp(ranges: ReadonlyArray<CodePointRange>): RegExp {
  return new RegExp(
    ranges.map(([lo, hi]) => `[${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}]`).join("|"),
    "gu",
  );
}
