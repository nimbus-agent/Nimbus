// packages/gateway/src/connectors/connector-writes/markup-tokens.ts
// A structural tokenizer for model-written markup (Phase 9.7 PR B3r, plan R7): HTML, XHTML, SVG
// and Confluence storage. It is a state machine over UTF-16 code units, modelled on the WHATWG
// tokenizer's data, tag-open, tag-name, attribute and comment states, and it has NO raw-text or
// RCDATA state: every `<` followed by an ASCII letter starts a tag everywhere, inside `<style>`,
// `<title>`, `<textarea>` and `<xmp>` too. That over-approximates both an HTML parser (which hides
// markup inside raw-text elements) and an XML parser (which has none).
//
// It only READS. It never normalises, strips or rewrites its input, and it returns no modified
// text: NFKC or entity decoding before tokenizing could turn a fullwidth quote into `"` and hide a
// live tag inside an attribute value, so normalisation applies only to the names and values the
// detectors (`remote-content.ts`) extract. Anything it cannot read to the end returns `undefined`,
// which every caller refuses (fail closed).
//
// Rules (exact):
//  - `<` + ASCII letter starts a start tag; `</` + ASCII letter an end tag. `<!--` starts a
//    comment, which ends at the first `-->` or `--!>` (`<!-->` and `<!--->` are empty comments);
//    `<![CDATA[` (case-sensitive) starts CDATA, which ends at `]]>`. Any other `<!`, `<?`, or `</`
//    + non-letter starts a declaration that ends at the first `>`. A `<` followed by anything else
//    is text.
//  - Whitespace inside a tag is exactly TAB, LF, FF, CR and SPACE (VT and NBSP are NOT), and a `/`
//    between attributes is a separator (`/>` marks the start tag self-closing).
//  - A tag name runs to whitespace, `/` or `>` (so `<im<x>` is one tag named `im<x`). An attribute
//    name runs to whitespace, `/`, `>` or `=`, and a leading `=` is part of it. After `=` (optional
//    whitespace around it) a value is quoted by `"` or `'` and ends at the same quote, or is
//    unquoted and ends at whitespace or `>` (so `x/` in `<img src=x/>` keeps its `/`).
//  - Every occurrence of a duplicated attribute is kept. End-tag attributes are read (so a quoted
//    `>` does not end the tag) and dropped.
//  - Does not tokenize: end of input inside a tag, an attribute value, a comment, CDATA or a
//    declaration; more than MARKUP_MAX_TOKENS tokens; an input longer than REMOTE_SCAN_MAX_CHARS.

/** One attribute as written: `value` is the raw source text between its quotes (or unquoted). */
export interface MarkupAttr {
  readonly name: string;
  readonly value: string;
  readonly quoted: boolean;
}

/**
 * One token. `name` keeps its source case (callers lower-case it). `start` and `end` are source
 * offsets, `end` exclusive, so `text.slice(start, end)` is the token's source. A declaration's
 * `text` is everything between its `<` and `>` (`!DOCTYPE html`, `?xml version="1.0"?`, `/1`);
 * a comment's and a CDATA section's `text` is their content without the delimiters.
 */
export type MarkupToken =
  | {
      readonly kind: "start";
      readonly name: string;
      readonly attrs: readonly MarkupAttr[];
      readonly selfClosing: boolean;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "end"; readonly name: string; readonly start: number; readonly end: number }
  | { readonly kind: "text"; readonly text: string; readonly start: number; readonly end: number }
  | {
      readonly kind: "comment";
      readonly text: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "cdata"; readonly text: string; readonly start: number; readonly end: number }
  | {
      readonly kind: "declaration";
      readonly text: string;
      readonly start: number;
      readonly end: number;
    };

/** More tokens than this does not tokenize (refused). */
export const MARKUP_MAX_TOKENS = 200_000;

/**
 * A longer input does not tokenize (refused). It bounds Confluence `storageHtml` and Obsidian
 * `content`, whose schemas have no maximum (Outlook's `body` is at most 1,000,000).
 */
export const REMOTE_SCAN_MAX_CHARS = 2_000_000;

const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQUALS = 0x3d;
const DQUOTE = 0x22;
const SQUOTE = 0x27;

/** TAB, LF, FF, CR and SPACE: the only whitespace inside a tag (not VT, not NBSP). */
function isTagSpace(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** A token read from a `<`, and the offset just past it. */
interface Read {
  readonly token: MarkupToken;
  readonly next: number;
}

/** The result of the tag-open state: a token, "this `<` is text", or does not tokenize. */
type TagOpen = Read | "text" | undefined;

/** The offset past the first run of tag whitespace from `i`. */
function skipTagSpace(src: string, i: number): number {
  let j = i;
  while (j < src.length && isTagSpace(src.charCodeAt(j))) j++;
  return j;
}

/** Tag-name state: the offset where the name starting at `i` ends (whitespace, `/` or `>`). */
function readTagName(src: string, i: number): number {
  let j = i;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (isTagSpace(c) || c === SLASH || c === GT) break;
    j++;
  }
  return j;
}

/** Attribute-value state, from just after the `=`; `undefined` at end of input. */
function readAttributeValue(
  src: string,
  afterEquals: number,
): { readonly value: string; readonly quoted: boolean; readonly next: number } | undefined {
  const i = skipTagSpace(src, afterEquals);
  if (i >= src.length) return undefined;
  const c = src.charCodeAt(i);
  if (c === DQUOTE || c === SQUOTE) {
    const close = src.indexOf(src.charAt(i), i + 1);
    if (close === -1) return undefined;
    return { value: src.slice(i + 1, close), quoted: true, next: close + 1 };
  }
  let j = i;
  while (j < src.length) {
    const d = src.charCodeAt(j);
    if (isTagSpace(d) || d === GT) break;
    j++;
  }
  return { value: src.slice(i, j), quoted: false, next: j };
}

/** The offset where an attribute name starting at `i` ends; its first character always counts. */
function readAttributeName(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (isTagSpace(c) || c === SLASH || c === GT || c === EQUALS) break;
    j++;
  }
  return j;
}

/**
 * Attribute states, from just after the tag name up to and including the closing `>`.
 * `undefined` when the input ends first.
 */
function readAttributes(
  src: string,
  from: number,
):
  | { readonly attrs: readonly MarkupAttr[]; readonly selfClosing: boolean; readonly next: number }
  | undefined {
  const attrs: MarkupAttr[] = [];
  let i = from;
  for (;;) {
    i = skipTagSpace(src, i);
    if (i >= src.length) return undefined;
    const c = src.charCodeAt(i);
    if (c === GT) return { attrs, selfClosing: false, next: i + 1 };
    if (c === SLASH) {
      if (src.charCodeAt(i + 1) === GT) return { attrs, selfClosing: true, next: i + 2 };
      i++;
      continue;
    }
    const nameEnd = readAttributeName(src, i);
    const name = src.slice(i, nameEnd);
    const afterName = skipTagSpace(src, nameEnd);
    if (afterName < src.length && src.charCodeAt(afterName) === EQUALS) {
      const v = readAttributeValue(src, afterName + 1);
      if (v === undefined) return undefined;
      attrs.push({ name, value: v.value, quoted: v.quoted });
      i = v.next;
    } else {
      attrs.push({ name, value: "", quoted: false });
      i = afterName;
    }
  }
}

/** A start tag at `lt` (`<` + ASCII letter). */
function readStartTag(src: string, lt: number): Read | undefined {
  const nameEnd = readTagName(src, lt + 1);
  const rest = readAttributes(src, nameEnd);
  if (rest === undefined) return undefined;
  const token: MarkupToken = {
    kind: "start",
    name: src.slice(lt + 1, nameEnd),
    attrs: rest.attrs,
    selfClosing: rest.selfClosing,
    start: lt,
    end: rest.next,
  };
  return { token, next: rest.next };
}

/** An end tag at `lt` (`</` + ASCII letter); its attributes are read and dropped. */
function readEndTag(src: string, lt: number): Read | undefined {
  const nameEnd = readTagName(src, lt + 2);
  const rest = readAttributes(src, nameEnd);
  if (rest === undefined) return undefined;
  const token: MarkupToken = {
    kind: "end",
    name: src.slice(lt + 2, nameEnd),
    start: lt,
    end: rest.next,
  };
  return { token, next: rest.next };
}

/** A comment at `lt` (`<!--`): it ends at the first `-->` or `--!>`. */
function readComment(src: string, lt: number): Read | undefined {
  const body = lt + 4;
  // `<!-->` and `<!--->` are complete, empty comments.
  if (src.startsWith(">", body)) {
    return { token: { kind: "comment", text: "", start: lt, end: body + 1 }, next: body + 1 };
  }
  if (src.startsWith("->", body)) {
    return { token: { kind: "comment", text: "", start: lt, end: body + 2 }, next: body + 2 };
  }
  const plain = src.indexOf("-->", body);
  const bang = src.indexOf("--!>", body);
  let close: number;
  let width: number;
  if (bang !== -1 && (plain === -1 || bang < plain)) {
    close = bang;
    width = 4;
  } else if (plain !== -1) {
    close = plain;
    width = 3;
  } else {
    return undefined;
  }
  const end = close + width;
  return { token: { kind: "comment", text: src.slice(body, close), start: lt, end }, next: end };
}

/** A CDATA section at `lt` (`<![CDATA[`): it ends at `]]>`. */
function readCdata(src: string, lt: number): Read | undefined {
  const body = lt + 9;
  const close = src.indexOf("]]>", body);
  if (close === -1) return undefined;
  const end = close + 3;
  return { token: { kind: "cdata", text: src.slice(body, close), start: lt, end }, next: end };
}

/** A declaration at `lt` (`<!`, `<?`, or `</` + non-letter): it ends at the first `>`. */
function readDeclaration(src: string, lt: number): Read | undefined {
  const close = src.indexOf(">", lt + 2);
  if (close === -1) return undefined;
  const end = close + 1;
  return {
    token: { kind: "declaration", text: src.slice(lt + 1, close), start: lt, end },
    next: end,
  };
}

/** Tag-open state, at a `<`: which construct starts here. */
function readTagOpen(src: string, lt: number): TagOpen {
  const c = src.charCodeAt(lt + 1);
  if (isAsciiLetter(c)) return readStartTag(src, lt);
  if (c === SLASH) {
    return isAsciiLetter(src.charCodeAt(lt + 2)) ? readEndTag(src, lt) : readDeclaration(src, lt);
  }
  if (c === BANG) {
    if (src.startsWith("<!--", lt)) return readComment(src, lt);
    if (src.startsWith("<![CDATA[", lt)) return readCdata(src, lt);
    return readDeclaration(src, lt);
  }
  if (c === QUESTION) return readDeclaration(src, lt);
  return "text";
}

/**
 * The tokens of `text` (plan R7), or `undefined` when it does not tokenize (refused). The data
 * state: text runs to the next `<` that opens a construct; consecutive text is one token.
 */
export function tokenizeMarkup(text: string): readonly MarkupToken[] | undefined {
  if (text.length > REMOTE_SCAN_MAX_CHARS) return undefined;
  const tokens: MarkupToken[] = [];
  let textStart = 0;
  let i = 0;
  for (;;) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    const open = readTagOpen(text, lt);
    if (open === undefined) return undefined;
    if (open === "text") {
      i = lt + 1;
      continue;
    }
    if (lt > textStart) {
      tokens.push({ kind: "text", text: text.slice(textStart, lt), start: textStart, end: lt });
    }
    tokens.push(open.token);
    if (tokens.length > MARKUP_MAX_TOKENS) return undefined;
    textStart = open.next;
    i = open.next;
  }
  if (textStart < text.length) {
    tokens.push({ kind: "text", text: text.slice(textStart), start: textStart, end: text.length });
  }
  return tokens.length > MARKUP_MAX_TOKENS ? undefined : tokens;
}
