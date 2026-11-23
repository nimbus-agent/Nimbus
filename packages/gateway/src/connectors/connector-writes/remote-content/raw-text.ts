// packages/gateway/src/connectors/connector-writes/remote-content/raw-text.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import type { MarkupToken } from "../markup-tokens.ts";
import { cssLoadsRemote, refusesStyleAttribute } from "./css.ts";
import type { MarkupRules } from "./elements.ts";
import { isAsciiLetterCode, localIn, STYLE, type StartToken } from "./shared.ts";

/**
 * The elements whose content an HTML parser reads as raw text: markup that ENDS inside one is
 * refused (Review fix 2), because its tail (CSS in a `<style>`) runs to the end of input.
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "style",
  "script",
  "title",
  "textarea",
  "xmp",
  "noembed",
  "noframes",
  "noscript",
]);

/** ASCII-only lower-casing: an HTML parser compares tag names this way, with no Unicode folding. */
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) ?? 0;
    out += c >= 0x41 && c <= 0x5a ? String.fromCodePoint(c + 0x20) : s.charAt(i);
  }
  return out;
}

/** What may follow an HTML raw-text end tag's name: TAB, LF, FF, CR, SPACE, `/` or `>`. */
function isHtmlEndDelimiter(c: number): boolean {
  return (
    c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20 || c === 0x2f || c === 0x3e
  );
}

/**
 * Where an HTML parser ends each raw-text element: for every raw-text name, the ascending source
 * offsets of each `</name` (ASCII case-insensitive, NO folding and NO local part) followed by a
 * delimiter. So `</style` + VT + `>`, `</style` + U+200B + `>` and `</x:style>` end nothing. One
 * forward pass over the text.
 */
function htmlRawTextClosers(text: string): ReadonlyMap<string, readonly number[]> {
  const out = new Map<string, number[]>();
  for (let at = text.indexOf("</"); at !== -1; at = text.indexOf("</", at + 2)) {
    let j = at + 2;
    while (j < text.length && isAsciiLetterCode(text.codePointAt(j) ?? -1)) j++;
    const name = asciiLower(text.slice(at + 2, j));
    if (!RAW_TEXT_ELEMENTS.has(name) || !isHtmlEndDelimiter(text.codePointAt(j) ?? -1)) continue;
    const list = out.get(name) ?? [];
    list.push(at);
    out.set(name, list);
  }
  return out;
}

/** One raw-text element's extent in both parsers' views. */
interface RawTextSpan {
  /** The token index of the XML end tag (exact, ASCII lower-cased qualified name). */
  readonly xmlEnd: number;
  /** The source offset where HTML ends it, when HTML reads it as raw text. */
  readonly htmlEnd: number | undefined;
  /** The later of the two: the union span runs from the start tag's end to here. */
  readonly unionEnd: number;
}

/** The first unused HTML closer of `qname` at or after the start tag's end (advances `cursor`). */
function nextHtmlCloser(
  qname: string,
  open: StartToken,
  closers: ReadonlyMap<string, readonly number[]>,
  cursor: Map<string, number>,
): number | undefined {
  const list = closers.get(qname) ?? [];
  let c = cursor.get(qname) ?? 0;
  while (c < list.length && (list[c] ?? 0) < open.end) c++;
  cursor.set(qname, c);
  return list[c];
}

/**
 * The token index of the XML end tag of the raw-text element opened at `k`, or `undefined` when a
 * raw-text start tag comes first (no nesting) or none closes it.
 */
function xmlEndTokenIndex(
  tokens: readonly MarkupToken[],
  k: number,
  qname: string,
): number | undefined {
  for (let j = k + 1; j < tokens.length; j++) {
    const u = tokens[j];
    if (u?.kind === "start" && localIn(u.name, RAW_TEXT_ELEMENTS)) return undefined;
    if (u?.kind === "end" && asciiLower(u.name) === qname) return j;
  }
  return undefined;
}

/** Whether a raw-text start tag begins among the tokens from `from` that start before `unionEnd`. */
function startsRawTextBefore(
  tokens: readonly MarkupToken[],
  from: number,
  unionEnd: number,
): boolean {
  for (let j = from; j < tokens.length && (tokens[j]?.start ?? unionEnd) < unionEnd; j++) {
    const u = tokens[j];
    if (u?.kind === "start" && localIn(u.name, RAW_TEXT_ELEMENTS)) return true;
  }
  return false;
}

/**
 * The extent of the raw-text element opened at `k`, or `undefined` (refused) when either view
 * never closes it (Review fix 2) or another raw-text element starts inside it (nesting is never
 * needed, and refusing it keeps the walk linear). `cursor` holds, per name, the first unused
 * HTML closer: start tags are visited in source order and spans never overlap, so the whole
 * walk is O(tokens + text).
 */
function rawTextSpan(
  tokens: readonly MarkupToken[],
  k: number,
  open: StartToken,
  closers: ReadonlyMap<string, readonly number[]>,
  cursor: Map<string, number>,
): RawTextSpan | undefined {
  const qname = asciiLower(open.name);
  const isRawText = RAW_TEXT_ELEMENTS.has(qname);
  const htmlEnd = isRawText ? nextHtmlCloser(qname, open, closers, cursor) : undefined;
  if (isRawText && htmlEnd === undefined) return undefined;
  const xmlEnd = xmlEndTokenIndex(tokens, k, qname);
  if (xmlEnd === undefined) return undefined;
  const close = tokens[xmlEnd];
  if (close === undefined) return undefined;
  const unionEnd = Math.max(close.start, htmlEnd ?? 0);
  if (startsRawTextBefore(tokens, xmlEnd + 1, unionEnd)) return undefined;
  return { xmlEnd, htmlEnd, unionEnd };
}

/**
 * The CSS of a `<style>` element, in every view: the UNION span's source, HTML's span (to the
 * exact `</style`), XML's span (to its end tag), and XML's text (its text and CDATA tokens).
 */
function styleCssViews(
  tokens: readonly MarkupToken[],
  text: string,
  k: number,
  open: StartToken,
  span: RawTextSpan,
): readonly string[] {
  let xmlText = "";
  for (let j = k + 1; j < span.xmlEnd; j++) {
    const t = tokens[j];
    if (t?.kind === "text" || t?.kind === "cdata") xmlText += t.text;
  }
  const xmlClose = tokens[span.xmlEnd]?.start ?? span.unionEnd;
  const views = [text.slice(open.end, span.unionEnd), text.slice(open.end, xmlClose), xmlText];
  if (span.htmlEnd !== undefined) views.push(text.slice(open.end, span.htmlEnd));
  return views;
}

/**
 * R4 step 5, raw-text elements: each must close in both views, none may nest, and a `<style>`
 * element's CSS (every view) must not load. One forward pass.
 */
function refusesRawText(tokens: readonly MarkupToken[], text: string, rules: MarkupRules): boolean {
  const closers = htmlRawTextClosers(text);
  const cursor = new Map<string, number>();
  const opts = { allowFragmentUrl: rules.allowFragmentUrl };
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t?.kind !== "start" || !localIn(t.name, RAW_TEXT_ELEMENTS)) {
      k++;
      continue;
    }
    const span = rawTextSpan(tokens, k, t, closers, cursor);
    if (span === undefined) return true;
    if (localIn(t.name, STYLE)) {
      const views = styleCssViews(tokens, text, k, t, span);
      if (views.some((css) => cssLoadsRemote(css, opts))) return true;
    }
    k = span.xmlEnd + 1;
    while (k < tokens.length && (tokens[k]?.start ?? span.unionEnd) < span.unionEnd) k++;
  }
  return false;
}

/** R4 step 5: CSS in `style` attributes and in raw-text elements. */
export function refusesCss(
  tokens: readonly MarkupToken[],
  text: string,
  rules: MarkupRules,
): boolean {
  if (tokens.some((t) => t.kind === "start" && refusesStyleAttribute(t, rules.allowFragmentUrl))) {
    return true;
  }
  return refusesRawText(tokens, text, rules);
}
