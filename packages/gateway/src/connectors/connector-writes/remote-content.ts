// packages/gateway/src/connectors/connector-writes/remote-content.ts
// The remote-content detectors of Phase 9.7 PR B3r (owner rulings OR-B3-2 and OR-B3r-1..4): does
// a model-written draft, page, note or markup file load remote content (an external image, embed,
// frame, stylesheet, refresh or base URL) when someone opens it? `remoteContentIn(format, text)`
// returns `true` to refuse. Pure: a string in, a boolean out; no network, config or Vault.
//
// These are DETECTORS, never sanitizers: nothing here strips, rewrites or returns modified text
// (CodeQL js/incomplete-multi-character-sanitization, js/bad-tag-filter). HTML and storage are read
// through the structural tokenizer (`markup-tokens.ts`), and decisions are made on single
// extracted values (one attribute value, one CSS text, one parameter text) and on the textual
// tripwire (R6), whose patterns match no tag. A source pin (`markup-tokens.test.ts`) keeps
// `.replace(`, `RegExp(` and any regex literal containing `<` out of this file. Anything that
// does not tokenize, parse or settle is refused (fail closed).
//
// The rules (plan R2-R6), in the order each detector applies them:
//  1. The input does not tokenize: refused.
//  2. Elements (compared lower-cased, NFKC-folded with invisible characters deleted, and as the
//     local part after the last `:` of each): `base`, `link`, `iframe`, `frame`, `frameset`,
//     `object`, `embed`, `applet`, `portal`, `fencedframe`, `script`; `meta` with `http-equiv`.
//  3. Attributes on ANY element (compared the same ways): an external URL (R2) in `src`, `lowsrc`,
//     `dynsrc`, `poster`, `background`, `data`, `codebase`, `icon` or `manifest`; an external
//     `href` (`xlink:href`, any `*:href`) on any element whose local name is not `a` or `area`;
//     any non-empty `ping` or `archive` (URL lists, decided like `srcset`); any `on*` event
//     handler (script can fetch).
//  4. A non-empty `srcset` or `imagesrcset`, whatever its URLs.
//  5. CSS: a `style` attribute and the text of a `<style>` element (to its matching end tag, or
//     the end of input) that calls a loading function or `@import`s (`cssLoadsRemote`); markup
//     that ends inside an open `style`, `script`, `title`, `textarea`, `xmp`, `noembed`,
//     `noframes` or `noscript` element.
//  6. A comment, declaration or processing instruction whose text contains `<` (an Outlook
//     conditional comment is rendered by Outlook desktop).
//  7. CDATA: refused in Outlook HTML (an HTML parser ends it at the first `>`, an XML parser does
//     not); in Confluence storage it is scanned recursively (R5).
//  8. The textual tripwire (R6), over the raw, deleted-invisible and spaced-invisible forms.
// Confluence storage adds R5; Drive markup adds R12 (SVG, XHTML and XML forms). Notion JSON (R8)
// is parsed and walked, and Obsidian Markdown (R9) is the HTML scan plus a fixed `![` rule.
import { type MarkupToken, REMOTE_SCAN_MAX_CHARS, tokenizeMarkup } from "./markup-tokens.ts";
import { foldAndStrip, settle, settleUrl } from "./text-normalise.ts";

/** The body formats a scanned row's field is read as (see `REMOTE_CONTENT_SCANNED`). */
export type RemoteContentFormat =
  | "outlook-html"
  | "confluence-storage"
  | "notion-blocks"
  | "notion-properties"
  | "obsidian-markdown"
  | "drive-markup";

// ---------------------------------------------------------------------------------------------
// R2: what "external" means.
// ---------------------------------------------------------------------------------------------

const SCHEME = /^[a-z][a-z0-9+.-]*:/;
/** A character reference the gateway's six-name decoder left unresolved (`;` required). */
const UNRESOLVED_REFERENCE = /&(?:[a-z][a-z0-9]*|#[0-9]+|#x[0-9a-f]+);/;

/** The RAW form: lower-cased, TAB/LF/CR deleted anywhere, leading and trailing C0 and space trimmed. */
function rawUrlForm(value: string): string {
  let out = "";
  for (const ch of value.toLowerCase()) {
    if (ch !== "\t" && ch !== "\n" && ch !== "\r") out += ch;
  }
  let lo = 0;
  let hi = out.length;
  while (lo < hi && out.charCodeAt(lo) <= 0x20) lo++;
  while (hi > lo && out.charCodeAt(hi - 1) <= 0x20) hi--;
  return out.slice(lo, hi);
}

function isSlash(ch: string | undefined): boolean {
  return ch === "/" || ch === "\\";
}

/** R2 (a) and (b) on one form: protocol-relative, or any scheme but an allowed `cid:`. */
function formIsExternal(form: string, allowCid: boolean): boolean {
  if (isSlash(form[0]) && isSlash(form[1])) return true;
  if (!SCHEME.test(form)) return false;
  return !(allowCid && form.startsWith("cid:"));
}

/**
 * R2: whether a URL-bearing value is external. Checked in the RAW form and in the SETTLED form
 * (`settleUrl`; a value that does not settle is external), either deciding "external" refuses:
 * protocol-relative (`//`, `\\`, `/\`, `\/`), any scheme (`cid:` excepted when `allowCid`), or a
 * settled form still holding a character reference the decoder does not resolve (`&sol;`, which
 * a browser reads as `/`). Not external: `""`, `#...` and every other relative reference. The
 * service's own host is NOT exempted (the tenant is not known here; stated).
 */
export function urlIsExternal(value: string, opts: { readonly allowCid: boolean }): boolean {
  if (formIsExternal(rawUrlForm(value), opts.allowCid)) return true;
  const settled = settleUrl(value);
  if (settled === undefined) return true;
  return formIsExternal(settled, opts.allowCid) || UNRESOLVED_REFERENCE.test(settled);
}

// ---------------------------------------------------------------------------------------------
// Name forms (R4 step 2): lower-cased, folded, and the local part after the last `:` of each.
// ---------------------------------------------------------------------------------------------

function localPart(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** The local parts of a name: of its lower-cased form and of its folded lower-cased form. */
function localForms(name: string): readonly string[] {
  return [localPart(name.toLowerCase()), localPart(foldAndStrip(name).toLowerCase())];
}

/** Every form a name is compared in (lower-cased, folded, and the local part of each). */
function nameForms(name: string): readonly string[] {
  const lower = name.toLowerCase();
  const folded = foldAndStrip(name).toLowerCase();
  return [lower, folded, localPart(lower), localPart(folded)];
}

function nameIn(name: string, set: ReadonlySet<string>): boolean {
  return nameForms(name).some((f) => set.has(f));
}

/** A value's settled forms (deleted and spaced invisible), trimmed; `undefined` if unsettled. */
function settledForms(value: string): readonly string[] | undefined {
  const deleted = settle(value, "");
  const spaced = settle(value, " ");
  if (deleted === undefined || spaced === undefined) return undefined;
  return [deleted.trim(), spaced.trim()];
}

/** The text of one value in every form it is compared in: raw lower-trimmed and settled. */
function valueForms(value: string): readonly string[] | undefined {
  const settled = settledForms(value);
  return settled === undefined ? undefined : [value.toLowerCase().trim(), ...settled];
}

type StartToken = Extract<MarkupToken, { kind: "start" }>;

// ---------------------------------------------------------------------------------------------
// R4 step 2: elements refused whatever their attributes.
// ---------------------------------------------------------------------------------------------

const REFUSED_ELEMENTS: ReadonlySet<string> = new Set([
  "base",
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "script",
]);

/** Confluence's own link element, whose local name is `link` (R3: always allowed in storage). */
const CONFLUENCE_LINK_ELEMENT = "ac:link";

interface MarkupRules {
  /** Outlook HTML: an `<img src="cid:...">` names an inline part (R3). */
  readonly allowCid: boolean;
  /** Confluence storage: `<ac:link>` is a plain link, not a `<link>`. */
  readonly confluence: boolean;
  /** Drive markup (R12): a CSS `url(` whose argument starts with `#` is allowed. */
  readonly allowFragmentUrl: boolean;
}

function isConfluenceLink(t: StartToken): boolean {
  return (
    t.name.toLowerCase() === CONFLUENCE_LINK_ELEMENT &&
    foldAndStrip(t.name).toLowerCase() === CONFLUENCE_LINK_ELEMENT
  );
}

function refusesElement(t: StartToken, rules: MarkupRules): boolean {
  if (nameIn(t.name, REFUSED_ELEMENTS) && !(rules.confluence && isConfluenceLink(t))) return true;
  return nameIn(t.name, META) && t.attrs.some((a) => nameIn(a.name, HTTP_EQUIV));
}

const META: ReadonlySet<string> = new Set(["meta"]);
const HTTP_EQUIV: ReadonlySet<string> = new Set(["http-equiv"]);

// ---------------------------------------------------------------------------------------------
// R4 steps 3 and 4: URL-bearing attributes.
// ---------------------------------------------------------------------------------------------

const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src",
  "lowsrc",
  "dynsrc",
  "poster",
  "background",
  "data",
  "codebase",
  "manifest",
  "icon",
]);
const HREF: ReadonlySet<string> = new Set(["href"]);
const LINK_ELEMENTS: ReadonlySet<string> = new Set(["a", "area"]);
/** URL lists (and `srcset` candidate lists): refused when non-empty, whatever the URLs. */
const URL_LIST_ATTRIBUTES: ReadonlySet<string> = new Set([
  "srcset",
  "imagesrcset",
  "ping",
  "archive",
]);

/** Whether the element is a plain link: every local form is `a` or `area`. */
function isLinkElement(t: StartToken): boolean {
  return localForms(t.name).every((l) => LINK_ELEMENTS.has(l));
}

/** An `on*` event-handler attribute in any of its name forms. */
function isEventHandler(name: string): boolean {
  return localForms(name).some((l) => l.startsWith("on"));
}

function refusesAttributes(t: StartToken, rules: MarkupRules): boolean {
  const link = isLinkElement(t);
  const opts = { allowCid: rules.allowCid };
  return t.attrs.some((a) => {
    if (isEventHandler(a.name)) return true;
    if (nameIn(a.name, URL_LIST_ATTRIBUTES)) return rawUrlForm(a.value) !== "";
    if (nameIn(a.name, URL_ATTRIBUTES) && urlIsExternal(a.value, opts)) return true;
    return !link && nameIn(a.name, HREF) && urlIsExternal(a.value, opts);
  });
}

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
      if (ch === quote || isCssNewline(ch)) quote = "";
      i++;
      continue;
    }
    if (ch === "/" && css.charAt(i + 1) === "*") {
      const close = css.indexOf("*/", i + 2);
      if (close === -1) return undefined;
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
    i++;
  }
  return out;
}

/** U+FFFD, written as a number (a formatter can turn an escape into the character itself). */
const REPLACEMENT_CHARACTER = 0xfffd;

/** The code point a hex escape names (U+FFFD for zero, a surrogate or past U+10FFFF). */
function escapedCodePoint(hex: string): string {
  const cp = Number.parseInt(hex, 16);
  const invalid = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff);
  return String.fromCodePoint(invalid ? REPLACEMENT_CHARACTER : cp);
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
      if (css.charAt(j) === "\r" && css.charAt(j + 1) === "\n") j += 2;
      else if (isCssSpace(css.charAt(j))) j++;
      i = j;
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
function cssForms(css: string): readonly string[] | undefined {
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

/**
 * The argument of the `url(` whose `(` ends at `open`: whitespace skipped, an optional quote,
 * read to the matching quote or `)`, trimmed. `undefined` when it is unterminated.
 */
function urlArgument(css: string, open: number): string | undefined {
  let i = open;
  while (isCssSpace(css.charAt(i))) i++;
  const q = css.charAt(i);
  const quoted = q === '"' || q === "'";
  const from = quoted ? i + 1 : i;
  const close = css.indexOf(quoted ? q : ")", from);
  if (close === -1) return undefined;
  return css.slice(from, close).trim();
}

/** Whether a normalised form has a `url(` that loads: any, or (Drive) one not starting with `#`. */
function cssUrlLoads(form: string, allowFragmentUrl: boolean): boolean {
  for (const m of form.matchAll(CSS_URL_FUNCTION)) {
    if (!allowFragmentUrl) return true;
    const arg = urlArgument(form, m.index + m[0].length);
    if (arg === undefined || !arg.startsWith("#")) return true;
  }
  return false;
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

const STYLE: ReadonlySet<string> = new Set(["style"]);

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

/** The index of the end tag closing the element opened at `k` (nesting counted), or -1. */
function matchingEnd(tokens: readonly MarkupToken[], k: number, set: ReadonlySet<string>): number {
  let depth = 0;
  for (let j = k + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === undefined || (t.kind !== "start" && t.kind !== "end")) continue;
    if (!localForms(t.name).some((l) => set.has(l))) continue;
    if (t.kind === "start") depth++;
    else if (depth === 0) return j;
    else depth--;
  }
  return -1;
}

function localIn(name: string, set: ReadonlySet<string>): boolean {
  return localForms(name).some((l) => set.has(l));
}

/** ASCII-only lower-casing: an HTML parser compares tag names this way, with no Unicode folding. */
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s.charAt(i);
  }
  return out;
}

function isAsciiLetterCode(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
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
    while (j < text.length && isAsciiLetterCode(text.charCodeAt(j))) j++;
    const name = asciiLower(text.slice(at + 2, j));
    if (!RAW_TEXT_ELEMENTS.has(name) || !isHtmlEndDelimiter(text.charCodeAt(j))) continue;
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
  let htmlEnd: number | undefined;
  if (RAW_TEXT_ELEMENTS.has(qname)) {
    const list = closers.get(qname) ?? [];
    let c = cursor.get(qname) ?? 0;
    while (c < list.length && (list[c] ?? 0) < open.end) c++;
    cursor.set(qname, c);
    htmlEnd = list[c];
    if (htmlEnd === undefined) return undefined;
  }
  let xmlEnd = -1;
  for (let j = k + 1; j < tokens.length && xmlEnd === -1; j++) {
    const u = tokens[j];
    if (u?.kind === "start" && localIn(u.name, RAW_TEXT_ELEMENTS)) return undefined;
    if (u?.kind === "end" && asciiLower(u.name) === qname) xmlEnd = j;
  }
  const close = tokens[xmlEnd];
  if (close === undefined) return undefined;
  const unionEnd = Math.max(close.start, htmlEnd ?? 0);
  for (let j = xmlEnd + 1; j < tokens.length && (tokens[j]?.start ?? unionEnd) < unionEnd; j++) {
    const u = tokens[j];
    if (u?.kind === "start" && localIn(u.name, RAW_TEXT_ELEMENTS)) return undefined;
  }
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
function refusesCss(tokens: readonly MarkupToken[], text: string, rules: MarkupRules): boolean {
  if (tokens.some((t) => t.kind === "start" && refusesStyleAttribute(t, rules.allowFragmentUrl))) {
    return true;
  }
  return refusesRawText(tokens, text, rules);
}

// ---------------------------------------------------------------------------------------------
// R4 steps 6 and 7: comments, declarations, processing instructions and CDATA.
// ---------------------------------------------------------------------------------------------

function refusesMarkupInDeclarations(tokens: readonly MarkupToken[]): boolean {
  return tokens.some(
    (t) => (t.kind === "comment" || t.kind === "declaration") && t.text.includes("<"),
  );
}

function hasCdata(tokens: readonly MarkupToken[]): boolean {
  return tokens.some((t) => t.kind === "cdata");
}

// ---------------------------------------------------------------------------------------------
// R6: the textual tripwire (defence in depth against a tokenizer/parser differential). Over the
// raw lower-cased text and its two settled forms. Stated over-refusal: prose or code that
// literally contains `src="https://...`, `url(` or `@import` is refused. The widened CSS
// function names (Review fix 1) are matched with no whitespace before `(`, as CSS requires, so
// prose such as "the image (left)" is not refused by the tripwire.
// ---------------------------------------------------------------------------------------------

// No two unbounded quantifiers are adjacent over the same characters (adversarial review): the
// optional quote and the whitespace after it are ONE optional group, so `src=` followed by a
// million spaces is read in linear time. Pinned by the timing tests.
const URL_ASSIGNMENT_TRIPWIRE_CID =
  /\b(?:src|srcset|lowsrc|dynsrc|poster|background)\s*=\s*(?:["'\x60]\s*)?(?:[\\/][\\/]|(?!cid:)[a-z][a-z0-9+.-]*:)/;
const URL_ASSIGNMENT_TRIPWIRE =
  /\b(?:src|srcset|lowsrc|dynsrc|poster|background)\s*=\s*(?:["'\x60]\s*)?(?:[\\/][\\/]|[a-z][a-z0-9+.-]*:)/;
const CSS_TRIPWIRE = /url\s*\(|@import|(?:image|image-set|cross-fade|element|src)\(/;
/** Drive markup: a `url(` whose argument starts with `#` (an SVG fragment) is not tripped. */
const CSS_TRIPWIRE_DRIVE =
  /url\s*\((?!\s*(?:["']\s*)?#)|@import|(?:image|image-set|cross-fade|element|src)\(/;

type TripwireKind = "outlook" | "default" | "drive";

/** R6 over the three forms of `text`; an unsettled text trips it. */
function tripwire(text: string, kind: TripwireKind): boolean {
  const deleted = settle(text, "");
  const spaced = settle(text, " ");
  if (deleted === undefined || spaced === undefined) return true;
  const assignment = kind === "outlook" ? URL_ASSIGNMENT_TRIPWIRE_CID : URL_ASSIGNMENT_TRIPWIRE;
  const css = kind === "drive" ? CSS_TRIPWIRE_DRIVE : CSS_TRIPWIRE;
  return [text.toLowerCase(), deleted, spaced].some((f) => assignment.test(f) || css.test(f));
}

// ---------------------------------------------------------------------------------------------
// The per-token rules of R4 steps 2-5 for one token stream.
// ---------------------------------------------------------------------------------------------

/** Deeper nested views than this are refused. */
const NESTED_VIEW_MAX_DEPTH = 4;

/**
 * The nested view (a tokenizer differential, Review Focus 1): a `<` + ASCII letter INSIDE a tag's
 * source (in a name, as in `<a <img src=//h>>` or `<im<link href=//h>`, or in a quoted value) is
 * where a lenient parser may start a tag this tokenizer does not. From each such `<` to the end of
 * the enclosing tag, the text is tokenized again and its start tags checked by steps 2-3 and their
 * `style` attributes. A view that does not tokenize starts no complete tag and refuses nothing.
 */
function refusesNestedView(
  t: Extract<MarkupToken, { kind: "start" | "end" }>,
  text: string,
  rules: MarkupRules,
  depth: number,
): boolean {
  const source = text.slice(t.start, t.end);
  for (let at = source.indexOf("<", 1); at !== -1; at = source.indexOf("<", at + 1)) {
    const next = source.charCodeAt(at + 1);
    const letter = (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a);
    if (!letter) continue;
    if (depth >= NESTED_VIEW_MAX_DEPTH) return true;
    const view = source.slice(at);
    const inner = tokenizeMarkup(view);
    if (inner !== undefined && refusesTagsAt(inner, view, rules, depth + 1)) return true;
  }
  return false;
}

function refusesStyleAttribute(t: StartToken, allowFragmentUrl: boolean): boolean {
  return t.attrs.some(
    (a) => nameIn(a.name, STYLE) && cssLoadsRemote(a.value, { allowFragmentUrl }),
  );
}

function refusesTagsAt(
  tokens: readonly MarkupToken[],
  text: string,
  rules: MarkupRules,
  depth: number,
): boolean {
  return tokens.some((t) => {
    if (t.kind !== "start" && t.kind !== "end") return false;
    if (refusesNestedView(t, text, rules, depth)) return true;
    if (t.kind !== "start") return false;
    if (refusesElement(t, rules) || refusesAttributes(t, rules)) return true;
    return depth > 0 && refusesStyleAttribute(t, rules.allowFragmentUrl);
  });
}

/** R4 steps 2-4 (and the nested view) over one token stream. */
function refusesTags(tokens: readonly MarkupToken[], text: string, rules: MarkupRules): boolean {
  return refusesTagsAt(tokens, text, rules, 0);
}

/** Options of a detector; `tripwire: false` is the test seam that isolates the structural rules. */
interface DetectOptions {
  readonly tripwire: boolean;
}

/** Outlook HTML (R4, `cid:` allowed in URL attributes): the eight steps, in order. */
function outlookHtmlRemote(text: string, opts: DetectOptions): boolean {
  const rules: MarkupRules = { allowCid: true, confluence: false, allowFragmentUrl: false };
  const tokens = tokenizeMarkup(text); // step 1
  if (tokens === undefined) return true;
  return (
    refusesTags(tokens, text, rules) || // steps 2-4
    refusesCss(tokens, text, rules) || // step 5
    refusesMarkupInDeclarations(tokens) || // step 6
    hasCdata(tokens) || // step 7
    (opts.tripwire && tripwire(text, "outlook")) // step 8
  );
}

// ---------------------------------------------------------------------------------------------
// R5: Confluence storage, in addition to R4 (storage is XML that Confluence renders as HTML).
// ---------------------------------------------------------------------------------------------

/**
 * The macros the model may write (owner ruling OR-B3r-1: a fail-closed ALLOWLIST). Every other
 * macro (`iframe`, `widget`, `html`, `html-include`, `rss`, `gadget`, `roadmap`, any marketplace
 * macro) and a macro without `ac:name` is refused.
 */
export const CONFLUENCE_INERT_MACROS: ReadonlySet<string> = new Set([
  "info",
  "note",
  "tip",
  "warning",
  "panel",
  "code",
  "noformat",
  "expand",
  "toc",
  "status",
  "anchor",
  "excerpt",
  "excerpt-include",
  "include",
  "details",
  "children",
  "pagetree",
  "jira",
]);

/**
 * The `jira` macro's URL-bearing parameters, refused when non-empty whatever the value (owner
 * ruling OR-B3r-1): `url` is the Jira XML or RSS issue-navigator URL Confluence itself fetches,
 * and `baseurl` the base it builds issue links from. Confirmed against Atlassian's Jira Issues
 * macro reference (https://confluence.atlassian.com/doc/jira-issues-macro-139380.html, retrieved
 * 2026-11-05: its parameters are `anonymous`, `baseurl`, `columns`, `count`, `cache`, `height`,
 * `renderMode`, `title`, `url` and `width`, and only `url` and `baseurl` take a URL). `server-url`
 * is kept as well (fail closed). `server` / `serverId` name a configured application link, which
 * is why the macro is allowed (stated bound: it shows issues only from a Jira the tenant admin
 * linked); every other parameter falls under the external-URL rule.
 */
const JIRA_URL_PARAMETERS: ReadonlySet<string> = new Set(["url", "baseurl", "server-url"]);

const MACRO_ELEMENTS: ReadonlySet<string> = new Set(["structured-macro", "macro"]);
const PARAMETER: ReadonlySet<string> = new Set(["parameter"]);
const PLAIN_TEXT_BODY: ReadonlySet<string> = new Set(["plain-text-body"]);
const NAME_ATTRIBUTE: ReadonlySet<string> = new Set(["name"]);
const CODE_MACROS: ReadonlySet<string> = new Set(["code", "noformat"]);
/** Deeper CDATA nesting than this is refused. */
const CDATA_MAX_DEPTH = 2;

/**
 * The names a macro or parameter element gives itself: every attribute whose local name is
 * `name` (`ac:name`; duplicates kept), in every form. `undefined` when a value does not settle.
 */
function elementNames(t: StartToken): readonly string[] | undefined {
  const out: string[] = [];
  for (const a of t.attrs) {
    if (!localIn(a.name, NAME_ATTRIBUTE)) continue;
    const forms = valueForms(a.value);
    if (forms === undefined) return undefined;
    out.push(...forms);
  }
  return out;
}

/** A macro's names when every form of every `ac:name` is an inert macro; else `undefined`. */
function inertMacroNames(t: StartToken): readonly string[] | undefined {
  const names = elementNames(t);
  if (names === undefined || names.length === 0) return undefined;
  return names.every((n) => CONFLUENCE_INERT_MACROS.has(n)) ? names : undefined;
}

/** The macro names on the stack at each token (innermost last), for a forward walk. */
interface MacroWalk {
  readonly stack: (readonly string[])[];
}

/** Push or pop the macro stack for `t`; `false` when `t` is a macro that is refused. */
function stepMacros(walk: MacroWalk, t: MarkupToken): boolean {
  if (t.kind === "start" && localIn(t.name, MACRO_ELEMENTS)) {
    const names = inertMacroNames(t);
    if (names === undefined) return false;
    if (!t.selfClosing) walk.stack.push(names);
  } else if (t.kind === "end" && localIn(t.name, MACRO_ELEMENTS)) {
    walk.stack.pop();
  }
  return true;
}

/** Whether the innermost macro is a `code` or `noformat` macro (every name it gives). */
function inCodeMacro(walk: MacroWalk): boolean {
  const top = walk.stack.at(-1);
  return top?.every((n) => CODE_MACROS.has(n)) ?? false;
}

function isWhitespaceText(t: MarkupToken | undefined): boolean {
  return t?.kind === "text" && t.text.trim() === "";
}

/**
 * The CDATA token of an `ac:plain-text-body` opened at `k` when the CDATA is its only
 * non-whitespace content, or -1.
 */
function soleCdataOfBody(tokens: readonly MarkupToken[], k: number): number {
  let j = k + 1;
  if (isWhitespaceText(tokens[j])) j++;
  if (tokens[j]?.kind !== "cdata") return -1;
  const cdata = j;
  j++;
  if (isWhitespaceText(tokens[j])) j++;
  const end = tokens[j];
  return end?.kind === "end" && localIn(end.name, PLAIN_TEXT_BODY) ? cdata : -1;
}

/**
 * The CDATA tokens Confluence shows as escaped text: the sole content of an `ac:plain-text-body`
 * whose enclosing macro is `code` or `noformat`. They are not scanned, and their source spans are
 * left out of the tripwire input.
 */
function exemptCodeBodies(tokens: readonly MarkupToken[]): ReadonlySet<MarkupToken> {
  const walk: MacroWalk = { stack: [] };
  const out = new Set<MarkupToken>();
  tokens.forEach((t, k) => {
    stepMacros(walk, t);
    if (t.kind !== "start" || !localIn(t.name, PLAIN_TEXT_BODY) || !inCodeMacro(walk)) return;
    const cdata = tokens[soleCdataOfBody(tokens, k)];
    if (cdata !== undefined) out.add(cdata);
  });
  return out;
}

/** An `ac:parameter` opened at `k`: its names and its text (text and CDATA up to its end tag). */
function parameterAt(
  tokens: readonly MarkupToken[],
  open: StartToken,
  k: number,
): { readonly names: readonly string[]; readonly text: string } | undefined {
  const names = elementNames(open);
  const endIndex = matchingEnd(tokens, k, PARAMETER);
  if (names === undefined || endIndex === -1) return undefined;
  let text = "";
  for (const t of tokens.slice(k + 1, endIndex)) {
    if (t.kind === "text" || t.kind === "cdata") text += t.text;
  }
  return { names, text };
}

/**
 * The schemes that make an `ac:parameter` text a URL without a following `//` (coordinator
 * ruling on B3r concern 6, 2026-11-05). Any other scheme counts only when `//` follows it.
 */
const PARAMETER_URL_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "mailto",
  "tel",
  "blob",
  "filesystem",
  "about",
  "ws",
  "wss",
  "ftp",
  "http",
  "https",
]);
const PARAMETER_SCHEME = /^([a-z][a-z0-9+.-]*):(\/\/)?/;

/** One form of a parameter text: protocol-relative, a scheme + `//`, or a listed scheme. */
function parameterFormIsUrl(form: string): boolean {
  if (isSlash(form[0]) && isSlash(form[1])) return true;
  const m = PARAMETER_SCHEME.exec(form);
  if (m === null) return false;
  return m[2] !== undefined || PARAMETER_URL_SCHEMES.has(m[1] ?? "");
}

/**
 * R5 (narrowed by the coordinator ruling on B3r concern 6): an `ac:parameter` text is a URL only
 * when it has a REAL URL scheme (a scheme followed by `//`, or one of
 * {@link PARAMETER_URL_SCHEMES}) or is protocol-relative, in its RAW or SETTLED form (R2), or
 * when its settled form keeps an unresolved character reference (R2(c)). So a panel title such as
 * "Note: x" is allowed, while "JaVaScRiPt:x" and "//h" are refused. An unsettled text refuses.
 */
function parameterIsUrl(text: string): boolean {
  if (parameterFormIsUrl(rawUrlForm(text))) return true;
  const settled = settleUrl(text);
  if (settled === undefined) return true;
  return parameterFormIsUrl(settled) || UNRESOLVED_REFERENCE.test(settled);
}

/** R5 for one parameter: a URL value, or a non-empty `jira` URL parameter. */
function refusesParameter(
  tokens: readonly MarkupToken[],
  open: StartToken,
  k: number,
  walk: MacroWalk,
): boolean {
  const p = parameterAt(tokens, open, k);
  if (p === undefined) return true;
  if (parameterIsUrl(p.text)) return true;
  const inJira = walk.stack.at(-1)?.includes("jira") ?? false;
  return inJira && p.names.some((n) => JIRA_URL_PARAMETERS.has(n)) && rawUrlForm(p.text) !== "";
}

const URL_ELEMENT: ReadonlySet<string> = new Set(["url"]);

/** An `ri:url` (any prefix: `res:url` too) or an `ac:adf-*` element. */
function refusesStorageElement(t: StartToken): boolean {
  return localIn(t.name, URL_ELEMENT) || localForms(t.name).some((l) => l.startsWith("adf-"));
}

/**
 * R5 over one token stream: `ri:url` and `ac:adf-*` elements, macros outside the inert list (or
 * left open), parameters, and CDATA scanned recursively (R4 steps 2-6 and R5, depth at most
 * {@link CDATA_MAX_DEPTH}) unless it is an exempt code body.
 */
function refusesStorage(
  tokens: readonly MarkupToken[],
  exempt: ReadonlySet<MarkupToken>,
  depth: number,
): boolean {
  const walk: MacroWalk = { stack: [] };
  const refused = tokens.some((t, k) => {
    if (!stepMacros(walk, t)) return true;
    if (t.kind === "start" && refusesStorageElement(t)) return true;
    if (t.kind === "start" && localIn(t.name, PARAMETER)) {
      return refusesParameter(tokens, t, k, walk);
    }
    return t.kind === "cdata" && !exempt.has(t) && refusesStorageCdata(t.text, depth);
  });
  return refused || walk.stack.length > 0;
}

/** R5 CDATA: its content tokenized and scanned as storage, one level deeper. */
function refusesStorageCdata(content: string, depth: number): boolean {
  // Defence in depth: a CDATA section cannot hold a complete one (its `]]>` would end the
  // outer), so a nested opener never tokenizes and this bound is not reached in practice.
  if (depth >= CDATA_MAX_DEPTH) return true;
  const inner = tokenizeMarkup(content);
  if (inner === undefined) return true;
  return storageRules(inner, content, depth + 1);
}

/** R4 steps 2-6 and R5 over one storage token stream (no tripwire; the caller runs it once). */
function storageRules(tokens: readonly MarkupToken[], text: string, depth: number): boolean {
  const rules: MarkupRules = { allowCid: false, confluence: true, allowFragmentUrl: false };
  const exempt = depth === 0 ? exemptCodeBodies(tokens) : new Set<MarkupToken>();
  return (
    refusesTags(tokens, text, rules) || // steps 2-4
    refusesCss(tokens, text, rules) || // step 5
    refusesMarkupInDeclarations(tokens) || // step 6
    refusesStorage(tokens, exempt, depth) // step 7 (CDATA) and R5
  );
}

/** The source outside the exempt code bodies (a slice by offsets, not a strip). */
function textOutside(
  text: string,
  tokens: readonly MarkupToken[],
  exempt: ReadonlySet<MarkupToken>,
): string {
  let out = "";
  let at = 0;
  for (const t of tokens) {
    if (!exempt.has(t)) continue;
    out += text.slice(at, t.start);
    at = t.end;
  }
  return out + text.slice(at);
}

/** Confluence storage (R4 + R5, no `cid:`): the eight steps, in order. */
function confluenceStorageRemote(text: string, opts: DetectOptions): boolean {
  const tokens = tokenizeMarkup(text); // step 1
  if (tokens === undefined) return true;
  if (storageRules(tokens, text, 0)) return true; // steps 2-7 and R5
  const exempt = exemptCodeBodies(tokens);
  return opts.tripwire && tripwire(textOutside(text, tokens, exempt), "default"); // step 8
}

// ---------------------------------------------------------------------------------------------
// R8: Notion block and property JSON. `JSON.parse`, then an iterative walk with an explicit stack
// over every array element and every own enumerable key (`Object.entries`, so a JSON `__proto__`
// key is visited). Keys are compared lower-cased. Duplicate keys are not a gap: both Notion tools
// `JSON.parse` then `JSON.stringify` before sending, so Notion receives exactly what was walked
// (pinned against the connector source in Task 5).
// ---------------------------------------------------------------------------------------------

/** Containers nested deeper than this are refused (Notion itself takes two levels of children). */
const NOTION_SCAN_MAX_DEPTH = 64;
/** More values than this are refused. */
const NOTION_SCAN_MAX_NODES = 100_000;

/** (a) and (b): an own key that loads or unfurls an external URL, whatever its value. */
const NOTION_REFUSED_KEYS: ReadonlySet<string> = new Set([
  "external",
  "embed",
  "bookmark",
  "link_preview",
  "link_mention",
]);
/** (c): a media key whose value is an object with its own `url`. */
const NOTION_MEDIA_KEYS: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "pdf",
  "file",
  "custom_emoji",
]);
/** (d): an own `type` naming one of these. */
const NOTION_REFUSED_TYPES: ReadonlySet<string> = new Set([
  "external",
  "embed",
  "bookmark",
  "link_preview",
  "link_mention",
]);

function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwnUrl(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).some((k) => k.toLowerCase() === "url");
}

/** R8 (a)-(d) on one plain object's own keys. */
function notionObjectRefused(obj: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(obj).some(([key, value]) => {
    const k = key.toLowerCase();
    if (NOTION_REFUSED_KEYS.has(k)) return true;
    if (NOTION_MEDIA_KEYS.has(k) && hasOwnUrl(value)) return true;
    return (
      k === "type" && typeof value === "string" && NOTION_REFUSED_TYPES.has(value.toLowerCase())
    );
  });
}

/** R8: Notion `childrenJson` (an array) or `propertiesJson` (a plain object). */
function notionRemote(text: string, shape: "blocks" | "properties"): boolean {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return true;
  }
  if (shape === "blocks" ? !Array.isArray(root) : !isPlainObject(root)) return true;
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 1 }];
  let nodes = 0;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    nodes++;
    if (nodes > NOTION_SCAN_MAX_NODES) return true;
    const { value, depth } = top;
    let children: readonly unknown[];
    if (Array.isArray(value)) {
      children = value;
    } else if (isPlainObject(value)) {
      if (notionObjectRefused(value)) return true;
      children = Object.values(value);
    } else {
      continue;
    }
    if (depth > NOTION_SCAN_MAX_DEPTH) return true;
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// R9: Obsidian Markdown. Obsidian renders Markdown images and inline HTML in reading view.
// Refused: (a) the R4 HTML scan of the whole note (Markdown read as text, inline HTML as markup;
// no `cid:`); (b) any `![` that does not begin a well-formed vault embed `![[target]]` (target
// non-empty, no `:`, not starting with `/` or `\`, not followed by `(` or `[`, which could make
// it a Markdown image), in the raw and both settled forms, so every Markdown image is refused,
// even a relative one (the destination cannot be found without a CommonMark parser); (c) R6.
// Fenced code blocks and escaped `\![` are not exempt (stated over-refusal).
// ---------------------------------------------------------------------------------------------

/** Whether the `![` at `at` begins a well-formed vault embed. */
function isVaultEmbed(form: string, at: number): boolean {
  if (!form.startsWith("![[", at)) return false;
  const close = form.indexOf("]]", at + 3);
  if (close === -1) return false;
  const target = form.slice(at + 3, close);
  if (target === "" || target.includes(":") || isSlash(target[0])) return false;
  const after = form.charAt(close + 2);
  return after !== "(" && after !== "[";
}

/** R9 (b): a `![` that is not a vault embed, in any form (an unsettled note is refused). */
function markdownImageRemote(text: string): boolean {
  const deleted = settle(text, "");
  const spaced = settle(text, " ");
  if (deleted === undefined || spaced === undefined) return true;
  return [text, deleted, spaced].some((form) => {
    for (let at = form.indexOf("!["); at !== -1; at = form.indexOf("![", at + 1)) {
      if (!isVaultEmbed(form, at)) return true;
    }
    return false;
  });
}

/** R9: an Obsidian note, (a) then (b) then (c). */
function obsidianRemote(text: string, opts: DetectOptions): boolean {
  const rules: MarkupRules = { allowCid: false, confluence: false, allowFragmentUrl: false };
  const tokens = tokenizeMarkup(text); // (a) step 1
  if (tokens === undefined) return true;
  return (
    refusesTags(tokens, text, rules) || // (a) steps 2-4
    refusesCss(tokens, text, rules) || // (a) step 5
    refusesMarkupInDeclarations(tokens) || // (a) step 6
    hasCdata(tokens) || // (a) step 7
    markdownImageRemote(text) || // (b)
    (opts.tripwire && tripwire(text, "default")) // (c)
  );
}

// ---------------------------------------------------------------------------------------------
// R11: which Drive `mimeType` values scan (owner ruling OR-B3r-2), normalised and fail closed.
// ---------------------------------------------------------------------------------------------

/** The owner's three markup types (R11 (a)). */
const DRIVE_MARKUP_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);
/** R11 (b): any essence naming one of these is markup. */
const MARKUP_ESSENCE = /html|svg|xml/;
/** R11 (c): a Google Apps type Drive may convert into, which might fetch remote images. */
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";
/** R11 (d): a clean `type/subtype` token pair (lower-case only). */
const CLEAN_MIME_ESSENCE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** The essence of one form: cut at the first `;` (parameters dropped), spaces and TABs trimmed. */
function mimeEssence(form: string): string {
  const semi = form.indexOf(";");
  const essence = semi === -1 ? form : form.slice(0, semi);
  let lo = 0;
  let hi = essence.length;
  const blank = (ch: string): boolean => ch === " " || ch === "\t";
  while (lo < hi && blank(essence.charAt(lo))) lo++;
  while (hi > lo && blank(essence.charAt(hi - 1))) hi--;
  return essence.slice(lo, hi);
}

function essenceScans(essence: string): boolean {
  return (
    DRIVE_MARKUP_TYPES.has(essence) || // (a)
    MARKUP_ESSENCE.test(essence) || // (b)
    essence.startsWith(GOOGLE_APPS_PREFIX) || // (c)
    !CLEAN_MIME_ESSENCE.test(essence) // (d): empty or unclean
  );
}

/**
 * R11: whether a `gdrive_file_create` with this `mimeType` has its `content` scanned as
 * `drive-markup`. Absent (`undefined`): not scanned (the connector uses `text/plain`). Present
 * but not a string (`null` included): scanned. A string scans when the essence of its RAW
 * (lower-cased) or FOLDED (NFKC, invisible characters deleted, lower-cased) form is markup, a
 * Google Apps type, or not a clean `type/subtype` pair. Stated bound: Drive stores the type it
 * is given and nothing sniffs content, so a `text/plain` file holding HTML is not scanned.
 */
export function driveMimeTypeScans(mimeType: unknown): boolean {
  if (mimeType === undefined) return false;
  if (typeof mimeType !== "string") return true;
  const forms = [mimeType.toLowerCase(), foldAndStrip(mimeType).toLowerCase()];
  return forms.some((f) => essenceScans(mimeEssence(f)));
}

// ---------------------------------------------------------------------------------------------
// R12: SVG, XHTML and the XML forms (`drive-markup` = R4 + R12; no `cid:`). Drive content may be
// read by an HTML or an XML parser.
// ---------------------------------------------------------------------------------------------

const FOREIGN_OBJECT: ReadonlySet<string> = new Set(["foreignobject"]);
const ATTRIBUTE_NAME: ReadonlySet<string> = new Set(["attributename"]);
/** SMIL can set these at run time (`<set attributeName="href" to="//h"/>`). */
const SMIL_REFUSED_TARGETS: ReadonlySet<string> = new Set(["href", "src"]);
const EXTERNAL_IDENTIFIER = /\b(?:system|public)\b/;

/**
 * R12 SVG elements: `foreignObject` (any case, any prefix: it lays out an HTML subtree), and any
 * element whose `attributeName` (every form, local part) is `href` or `src` (SMIL `set`,
 * `animate`, `animateMotion`, `animateTransform`, `discard`; any element, fail closed).
 */
function refusesSvgElements(tokens: readonly MarkupToken[]): boolean {
  return tokens.some((t) => {
    if (t.kind !== "start") return false;
    if (localIn(t.name, FOREIGN_OBJECT)) return true;
    return t.attrs.some((a) => {
      if (!localIn(a.name, ATTRIBUTE_NAME)) return false;
      const forms = valueForms(a.value);
      return forms === undefined || forms.some((f) => SMIL_REFUSED_TARGETS.has(localPart(f)));
    });
  });
}

/** Whether one attribute value, read as CSS, calls a loading function or a non-`#` `url(`. */
function valueLoadsAsCss(value: string): boolean {
  // Only a value that can spell `(` (literally, as an entity, or as a CSS escape) can call one.
  if (!value.includes("(") && !value.includes("&") && !value.includes("\\")) return false;
  const forms = cssForms(value);
  return (
    forms === undefined || forms.some((f) => CSS_LOAD_FUNCTION.test(f) || cssUrlLoads(f, true))
  );
}

/**
 * R12 presentation attributes: any attribute other than `style` (R4 step 5) whose value calls a
 * CSS `url(` must give EVERY `url(` an argument starting with `#` (Review fix 3: `fill`,
 * `stroke`, `filter`, `mask`, `clip-path`, `marker-*`, and SMIL `values`, `to`, `from`, `by`);
 * the other loading functions (`mask` takes images) are refused outright.
 */
function refusesPresentationUrls(tokens: readonly MarkupToken[]): boolean {
  return tokens.some(
    (t) =>
      t.kind === "start" && t.attrs.some((a) => !nameIn(a.name, STYLE) && valueLoadsAsCss(a.value)),
  );
}

/**
 * R12 XML declarations: a `<!DOCTYPE ...>` (any `<!` declaration) with an external identifier
 * (`SYSTEM` or `PUBLIC`; an XML parser may fetch the DTD; owner-accepted over-refusal of the
 * standard XHTML doctype), and a processing instruction naming `xml-stylesheet`. An internal
 * subset holds `<` and is refused by R4 step 6.
 */
function refusesXmlDeclarations(tokens: readonly MarkupToken[]): boolean {
  return tokens.some((t) => {
    if (t.kind !== "declaration") return false;
    const forms = valueForms(t.text);
    if (forms === undefined) return true;
    if (t.text.startsWith("!")) return forms.some((f) => EXTERNAL_IDENTIFIER.test(f));
    return t.text.startsWith("?") && forms.some((f) => f.includes("xml-stylesheet"));
  });
}

/** Drive markup (R4 + R12, no `cid:`): R4's steps, then R12's, as one ordered list. */
function driveMarkupRemote(text: string, opts: DetectOptions): boolean {
  const rules: MarkupRules = { allowCid: false, confluence: false, allowFragmentUrl: true };
  const tokens = tokenizeMarkup(text); // R4 step 1
  if (tokens === undefined) return true;
  return (
    refusesTags(tokens, text, rules) || // R4 steps 2-4
    refusesCss(tokens, text, rules) || // R4 step 5, with R12's `#` relaxation
    refusesMarkupInDeclarations(tokens) || // R4 step 6
    hasCdata(tokens) || // R4 step 7
    refusesSvgElements(tokens) || // R12 SVG elements
    refusesPresentationUrls(tokens) || // R12 presentation attributes
    refusesXmlDeclarations(tokens) || // R12 XML declarations
    (opts.tripwire && tripwire(text, "drive")) // R4 step 8
  );
}

// ---------------------------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------------------------

/**
 * Whether `text`, written as `format`, would load remote content when opened (`true` refuses).
 * Fail closed: an input over {@link REMOTE_SCAN_MAX_CHARS}, one that does not tokenize or parse,
 * and any throw inside a detector all refuse. `opts.tripwire` is a TEST SEAM only (it isolates the
 * structural rules from R6); production callers pass two arguments.
 */
export function remoteContentIn(
  format: RemoteContentFormat,
  text: string,
  opts: DetectOptions = { tripwire: true },
): boolean {
  if (text.length > REMOTE_SCAN_MAX_CHARS) return true;
  try {
    switch (format) {
      case "outlook-html":
        return outlookHtmlRemote(text, opts);
      case "confluence-storage":
        return confluenceStorageRemote(text, opts);
      case "notion-blocks":
        return notionRemote(text, "blocks");
      case "notion-properties":
        return notionRemote(text, "properties");
      case "obsidian-markdown":
        return obsidianRemote(text, opts);
      case "drive-markup":
        return driveMarkupRemote(text, opts);
    }
  } catch {
    return true;
  }
}
