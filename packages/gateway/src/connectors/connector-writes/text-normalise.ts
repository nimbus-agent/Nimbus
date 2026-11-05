// packages/gateway/src/connectors/connector-writes/text-normalise.ts
// The connector-write text normalisation (Phase 9.7 B1, moved here unchanged in B3r): NFKC
// folding, invisible and control stripping, the six-name HTML entity decoder and the `settle`
// loop that repeats them until the text is stable. Every value they return is a MATCHING copy:
// nothing here is ever sent, shown or written back. The refusals in `model-write-refusals.ts` and
// the remote-content detectors in `remote-content.ts` read these copies to decide; neither strips
// or rewrites what the model wrote.
import { FORMAT_INVISIBLE_RANGES } from "../../util/invisible-text.ts";

/** The rounds of fold + strip + decode before the text must be stable. */
export const NORMALISE_MAX_ROUNDS = 4;

/** A character that renders as nothing (`util/invisible-text.ts`) or a C0/C1 control. */
export function isInvisibleOrControl(cp: number): boolean {
  return cp <= 0x1f || FORMAT_INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** `s` with every invisible or control character replaced by `replacement`. */
function replaceInvisible(s: string, replacement: string): string {
  let out = "";
  for (const ch of s) out += isInvisibleOrControl(ch.codePointAt(0) ?? 0) ? replacement : ch;
  return out;
}

/** NFKC (fullwidth forms fold to ASCII), then every invisible or control character deleted. */
export function foldAndStrip(s: string): string {
  return replaceInvisible(s.normalize("NFKC"), "");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: String.fromCodePoint(0xa0),
};

const ENTITY = /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/gi;

/** One pass of HTML entity decoding; an unknown name or an invalid code point is left as is. */
export function decodeEntitiesOnce(s: string): string {
  return s.replace(ENTITY, (m: string, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) {
      const lower = name.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, lower) ? (NAMED_ENTITIES[lower] ?? m) : m;
    }
    const cp = hex === undefined ? Number.parseInt(dec ?? "", 10) : Number.parseInt(hex, 16);
    const valid = Number.isInteger(cp) && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
    return valid ? String.fromCodePoint(cp) : m;
  });
}

/** TAB, LF, VT, FF and CR: whitespace in both forms, never deleted. */
function isLineSpace(cp: number): boolean {
  return cp >= 0x09 && cp <= 0x0d;
}

/**
 * A line break for the line-preserving form: LF, CR, VT, FF, NEL, and the Unicode line and
 * paragraph separators (counted as breaks whether or not a platform splits on them: fail closed).
 */
function isLineBreak(cp: number): boolean {
  return (cp >= 0x0a && cp <= 0x0d) || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}

/**
 * One round: NFKC, invisible/control characters replaced by `invisible`, one entity pass. With
 * `keepLines`, every line break becomes LF (a TAB a space); without it, TAB to CR are spaces.
 */
function normaliseRound(s: string, invisible: string, keepLines: boolean): string {
  let out = "";
  for (const ch of s.normalize("NFKC")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (keepLines && isLineBreak(cp)) out += "\n";
    else if (isLineSpace(cp)) out += " ";
    else out += isInvisibleOrControl(cp) ? invisible : ch;
  }
  return decodeEntitiesOnce(out);
}

/**
 * The stable, lower-cased form, or `undefined` when it does not settle (refused). Whitespace runs
 * collapse to one space, unless `keepLines`, which keeps one LF per line break.
 */
export function settle(text: string, invisible: string, keepLines = false): string | undefined {
  let cur = text;
  for (let i = 0; i < NORMALISE_MAX_ROUNDS; i++) {
    const next = normaliseRound(cur, invisible, keepLines);
    if (next === cur) {
      return (keepLines ? cur : cur.replaceAll(/\s+/g, " ")).toLowerCase();
    }
    cur = next;
  }
  return undefined;
}

/**
 * B3r (plan R2, the SETTLED form of a URL-bearing value): NFKC, then EVERY invisible or control
 * code point deleted (TAB, LF and CR included, as the WHATWG URL parser removes them, so
 * `/` + TAB + `/h` reads `//h`, where `settle` would give `/ /h`), then one entity pass, repeated
 * until stable (at most {@link NORMALISE_MAX_ROUNDS}; still changing is `undefined`, which the
 * caller refuses). The result is trimmed and lower-cased. An entity the decoder does not know
 * (`&sol;`) is kept, so the caller can see it.
 */
export function settleUrl(value: string): string | undefined {
  let cur = value;
  for (let i = 0; i < NORMALISE_MAX_ROUNDS; i++) {
    const next = decodeEntitiesOnce(foldAndStrip(cur));
    if (next === cur) return cur.trim().toLowerCase();
    cur = next;
  }
  return undefined;
}
