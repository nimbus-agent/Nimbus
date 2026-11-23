// packages/gateway/src/connectors/connector-writes/remote-content/css.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import { settle } from "../text-normalise.ts";
import { nameIn, STYLE, type StartToken } from "./shared.ts";

// ---------------------------------------------------------------------------------------------
// R4 step 5: CSS. Normalised in ONE forward pass per stage, never by a replace:
//  1. HTML entities decoded (the `settle` round; for a `<style>` element too, which
//     over-approximates), in the deleted and the spaced invisible forms, plus the raw form;
//  2. `/* ... */` comments removed BEFORE escapes (CSS Syntax 3 tokenizes comments first), string-
//     aware so a `/*` inside a quoted string is not a comment; an unterminated comment refuses;
//  3. CSS escapes decoded (`\` + 1-6 hex digits + one optional whitespace, or `\` + any other
//     character); decoding that ADDS a `/*` or `*/` refuses (an escape never forms a comment);
//  4. lower-cased. The comment-free form and the form with comments kept are both checked.
// Refused: `url(` (in Drive markup, unless EVERY `url(` argument starts with `#`), `image(`,
// `image-set(`, `cross-fade(`, `element(`, `src(`, `expression(` (optional whitespace before
// `(`; `-webkit-` and `-moz-` variants contain these), `@import` and `behavior`, whatever their
// arguments.
// ---------------------------------------------------------------------------------------------

const CSS_LOAD_FUNCTION = /(?:image|image-set|cross-fade|element|src|expression)\s*\(/;
const CSS_DECLARATION_LOADER = /@import|behavior/;
const CSS_URL_FUNCTION = /url\s*\(/g;

function isCssNewline(ch: string | undefined): boolean {
  return ch === "\n" || ch === "\r" || ch === "\f";
}

function isCssSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || isCssNewline(ch);
}

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-f]$/i.test(ch);
}

/** `css` without its comments (strings and escapes respected); `undefined` when one is unterminated. */
function cssWithoutComments(css: string): string | undefined {
  let out = "";
  let quote = "";
  let i = 0;
  while (i < css.length) {
    const ch = css.charAt(i);
    if (ch === "\\" && i + 1 < css.length) {
      out += css.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (quote !== "") {
      out += ch;
      if (closesCssString(ch, quote)) quote = "";
      i++;
      continue;
    }
    if (startsCssComment(css, i)) {
      const close = css.indexOf("*/", i + 2);
      if (close === -1) return undefined;
      i = close + 2;
      continue;
    }
    if (isCssQuote(ch)) quote = ch;
    out += ch;
    i++;
  }
  return out;
}

function closesCssString(ch: string, quote: string): boolean {
  return ch === quote || isCssNewline(ch);
}

function startsCssComment(css: string, i: number): boolean {
  return css.charAt(i) === "/" && css.charAt(i + 1) === "*";
}

function isCssQuote(ch: string): boolean {
  return ch === '"' || ch === "'";
}

/** U+FFFD, written as a number (a formatter can turn an escape into the character itself). */
const REPLACEMENT_CHARACTER = 0xfffd;

/** The code point a hex escape names (U+FFFD for zero, a surrogate or past U+10FFFF). */
function escapedCodePoint(hex: string): string {
  const cp = Number.parseInt(hex, 16);
  const invalid = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff);
  return String.fromCodePoint(invalid ? REPLACEMENT_CHARACTER : cp);
}

/** The offset past the one whitespace (CRLF counts as one) that ends a hex escape at `j`. */
function afterEscapeTerminator(css: string, j: number): number {
  if (css.charAt(j) === "\r" && css.charAt(j + 1) === "\n") return j + 2;
  return isCssSpace(css.charAt(j)) ? j + 1 : j;
}

/** `css` with its escapes decoded, in one forward pass (an escaped newline joins the lines). */
function cssEscapesDecoded(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css.charAt(i);
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < css.length && j - i <= 6 && isHexDigit(css.charAt(j))) j++;
    if (j > i + 1) {
      out += escapedCodePoint(css.slice(i + 1, j));
      i = afterEscapeTerminator(css, j);
      continue;
    }
    // `\` + a newline (a continuation) or at the end of input contributes nothing.
    if (j < css.length && !isCssNewline(css.charAt(j))) out += css.charAt(j);
    i = j + 1;
  }
  return out;
}

function occurrences(s: string, needle: string): number {
  let n = 0;
  for (let at = s.indexOf(needle); at !== -1; at = s.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** The normalised CSS forms to match, or `undefined` when the CSS must be refused unread. */
export function cssForms(css: string): readonly string[] | undefined {
  const deleted = settle(css, "");
  const spaced = settle(css, " ");
  if (deleted === undefined || spaced === undefined) return undefined;
  const out: string[] = [];
  for (const base of [css.toLowerCase(), deleted, spaced]) {
    const bare = cssWithoutComments(base);
    if (bare === undefined) return undefined;
    const decoded = cssEscapesDecoded(bare).toLowerCase();
    const gained =
      occurrences(decoded, "/*") > occurrences(bare, "/*") ||
      occurrences(decoded, "*/") > occurrences(bare, "*/");
    if (gained) return undefined;
    out.push(decoded, cssEscapesDecoded(base).toLowerCase());
  }
  return out;
}

/** A `url(` argument and the offset just past its closing `)`. */
interface UrlArgument {
  readonly value: string;
  readonly end: number;
}

/**
 * The argument of the `url(` whose `(` ends at `open`, read by CSS's own rules (final review item
 * 3): whitespace skipped; a quoted argument runs to its closing quote and may not cross a newline
 * (a CSS bad string); an unquoted one ends at the first whitespace, `(`, quote or `)` (a CSS bad
 * url otherwise). Either must then be followed, after optional whitespace, by `)`. `undefined`
 * (refused) for anything else. Each call reads its own argument only, so a walk over every `url(`
 * that resumes at `end` reads the CSS once.
 */
function urlArgument(css: string, open: number): UrlArgument | undefined {
  let i = open;
  while (isCssSpace(css.charAt(i))) i++;
  const q = css.charAt(i);
  const quoted = q === '"' || q === "'";
  const from = quoted ? i + 1 : i;
  let j = from;
  if (quoted) {
    while (j < css.length && css.charAt(j) !== q && !isCssNewline(css.charAt(j))) j++;
    if (css.charAt(j) !== q) return undefined;
  } else {
    while (j < css.length && !isUnquotedUrlStop(css.charAt(j))) j++;
  }
  const value = css.slice(from, j).trim();
  let k = quoted ? j + 1 : j;
  while (isCssSpace(css.charAt(k))) k++;
  if (css.charAt(k) !== ")") return undefined;
  return { value, end: k + 1 };
}

/** What ends an unquoted `url(` argument: whitespace, `(`, a quote or `)`. */
function isUnquotedUrlStop(ch: string): boolean {
  return isCssSpace(ch) || ch === "(" || ch === ")" || ch === '"' || ch === "'";
}

/**
 * Whether a normalised form has a `url(` that loads: any, or (Drive) one whose argument does not
 * start with `#`. The walk resumes after each argument's `)`, never inside it, so it is linear.
 */
export function cssUrlLoads(
  form: string,
  allowFragmentUrl: boolean,
  pattern: RegExp = CSS_URL_FUNCTION,
): boolean {
  pattern.lastIndex = 0;
  try {
    for (let m = pattern.exec(form); m !== null; m = pattern.exec(form)) {
      if (!allowFragmentUrl) return true;
      const arg = urlArgument(form, m.index + m[0].length);
      if (!arg?.value.startsWith("#")) return true;
      pattern.lastIndex = arg.end;
    }
    return false;
  } finally {
    pattern.lastIndex = 0;
  }
}

/**
 * R4 step 5 (and R12's relaxation with `allowFragmentUrl`): whether `css` loads remote content.
 * Every loading function and `@import` / `behavior` is refused, even with a relative or `cid:`
 * argument; with `allowFragmentUrl` (Drive markup) a `url(` is allowed only when EVERY `url(`
 * argument starts with `#` (an SVG gradient or filter reference). Unsettled, unterminated
 * comments and escape-built comment delimiters are refused.
 */
export function cssLoadsRemote(
  css: string,
  opts: { readonly allowFragmentUrl?: boolean } = {},
): boolean {
  const forms = cssForms(css);
  if (forms === undefined) return true;
  const fragment = opts.allowFragmentUrl === true;
  return forms.some(
    (f) => CSS_LOAD_FUNCTION.test(f) || CSS_DECLARATION_LOADER.test(f) || cssUrlLoads(f, fragment),
  );
}

export function refusesStyleAttribute(t: StartToken, allowFragmentUrl: boolean): boolean {
  return t.attrs.some(
    (a) => nameIn(a.name, STYLE) && cssLoadsRemote(a.value, { allowFragmentUrl }),
  );
}
