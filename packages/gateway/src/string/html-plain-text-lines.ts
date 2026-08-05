import { stripHtmlTagsToSpaces } from "./html-plain-text.ts";

/**
 * HTML → text, but LINE-preserving.
 *
 * `plainTextFromHtml` (`html-plain-text.ts`) is deliberately line-BLIND: it
 * collapses every whitespace run — including real newlines — into a single
 * space, because its consumers (Confluence, Bitbucket, Teams,
 * `index-rebody-rpc`) only want prose, never structure. That makes it wrong
 * for a caller that needs to run LINE-ANCHORED logic afterward — email
 * quoted-tail stripping (`stripQuotedTail`) matches markers like
 * `On ... wrote:` or `-----Original Message-----` against WHOLE lines, and a
 * flattened single-line body hides every marker inside running prose where it
 * can never match.
 *
 * The pipeline, in order (the order is load-bearing — see each step):
 *
 *  1. neutralise source newlines,
 *  2. drop `<style>` / `<script>` / `<head>` SECTIONS (contents included),
 *  3. escape a stray `<` that is not a tag start,
 *  4. insert a newline at each recognised block boundary,
 *  5. hand off to the existing (frozen, unmodified) `stripHtmlTagsToSpaces`,
 *  6. decode character references, per line,
 *  7. normalise horizontal whitespace within each line and collapse runs of
 *     blank lines — without ever merging two structural lines into one.
 *
 * `plainTextFromHtml`, `collapseWhitespace`, and `stripHtmlTagsToSpaces`
 * (`html-plain-text.ts`) are NOT modified here; their other consumers must
 * stay bit-identical. Steps 2, 3 and 6 are therefore local to this module,
 * not pushed down into the shared helpers.
 */

/**
 * Every recognised block boundary: the CLOSING tag of a block-level element,
 * a `<br>`/`<br/>`/`<br />` line break, or an OPENING `<li>` — list items are
 * frequently left unclosed in real-world HTML, so the opener alone must be
 * enough to separate one item from the next.
 *
 * The first alternative — `</li>` immediately followed by the next `<li...>`
 * — must be tried BEFORE the standalone closing/opening alternatives below
 * it: a well-formed `<li>One</li><li>Two</li>` has BOTH a closing and an
 * opening tag touching at the item boundary, and matching them separately
 * would insert two adjacent newlines (a spurious blank line between every
 * pair of list items) instead of the single boundary actually intended.
 * Matching the pair as one unit collapses it to a single `\n`, while a
 * genuinely unclosed list (`<li>One<li>Two`, no `</li>` anywhere) still falls
 * through to the standalone opening-`<li>` alternative.
 *
 * The `<li`/`<br` attribute-skip alternatives use `[^<>]*`, not the more
 * obvious `[^>]*`. `[^>]*` is unbounded and, on an input like
 * `"<li ".repeat(n)`, scans to end-of-string and backtracks at EVERY one of
 * the n start positions before failing (no `>` anywhere) — O(n²), a
 * remote-attacker-controlled body run synchronously on every indexed
 * message, before any body cap applies (measured: ~1.9s at n=40000, a clean
 * 4x per doubling). `[^<>]*` additionally excludes `<`, so it can only ever
 * scan as far as the NEXT `<` or `>` in the whole string — every attack
 * input that creates many start positions necessarily also plants a `<`
 * between them (each one starts with `<li`/`<br`), which bounds each
 * position's scan to the gap to that next delimiter. Summed over the whole
 * string, that is O(n) total, not O(n) per position — genuinely linear, not
 * just linear-with-a-large-constant like a `{0,400}` cap would be. Measured
 * empirically against three attack shapes (the exact repro above, a single
 * very long unterminated attribute, and many long unterminated attributes)
 * and confirmed sub-millisecond at every size tested, see
 * `html-plain-text-lines.test.ts`'s ReDoS regression test.
 *
 * The four alternatives are named separately and composed rather than written
 * as one line: the inlined form scored 36 on the regex-complexity gate (max
 * 20), and the `[^<>]` argument above had to be re-read out of three places to
 * be checked. The composed pattern is character-for-character what the literal
 * was — the alternation order, which the `</li><li>` note above depends on, is
 * the order of the array.
 */
/** A space then anything up to this tag's `>` — the `[^<>]*` bound is the ReDoS argument above. */
const TAG_ATTRS = String.raw`(?:\s[^<>]*)?`;
/** `</li>` immediately followed by the next `<li ...>` — matched as ONE unit. */
const LI_PAIR = String.raw`</li\s*>\s*<li${TAG_ATTRS}>`;
/** A closing block-level tag. */
const BLOCK_CLOSE = String.raw`</(?:p|div|tr|li|h[1-6]|blockquote)\s*>`;
/** `<br>`, `<br/>`, `<br />`. (No `String.raw`: the literal parts carry no escape.) */
const LINE_BREAK = `<br${TAG_ATTRS}/?>`;
/** A standalone opening `<li ...>`, for the frequently-unclosed real-world case. */
const LI_OPEN = `<li${TAG_ATTRS}>`;

const BLOCK_BOUNDARY_RE = new RegExp([LI_PAIR, BLOCK_CLOSE, LINE_BREAK, LI_OPEN].join("|"), "gi");

/**
 * Sections whose TEXT is markup, not prose.
 *
 * `stripHtmlTagsToSpaces` removes tags but keeps everything between them, so
 * a `<style>` block's CSS survives as "body text". Every other consumer of
 * these helpers is handed an HTML FRAGMENT (Confluence storage format,
 * Bitbucket/Teams rendered snippets), but Outlook hands us a complete Word-
 * composed DOCUMENT whose `<head><style>` routinely carries kilobytes of
 * `mso-` CSS — which would land AHEAD of the actual prose, eat the 16 KiB
 * body cap, and pollute `item_fts`, the glossary miner and the decisions
 * extractor with CSS tokens.
 */
const HIDDEN_SECTION_NAMES = ["style", "script", "head"] as const;
type HiddenSectionName = (typeof HIDDEN_SECTION_NAMES)[number];

/**
 * The OPENING tag of a hidden section. `[^<>]*` for the attribute skip, for
 * exactly the reason spelled out on `BLOCK_BOUNDARY_RE` above. `\b` keeps
 * `<header>` from reading as `<head`.
 */
const HIDDEN_SECTION_OPEN_RE = /<(style|script|head)\b[^<>]*>/gi;

/** Pre-compiled closers, so a document with many sections compiles nothing. */
const HIDDEN_SECTION_CLOSE_RE: Readonly<Record<HiddenSectionName, RegExp>> = {
  style: /<\/style\s*>/gi,
  script: /<\/script\s*>/gi,
  head: /<\/head\s*>/gi,
};

/**
 * Drop `<style>` / `<script>` / `<head>` sections, contents included.
 *
 * Deliberately NOT the obvious one-regex form
 * `/<(style|script|head)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi`. That is QUADRATIC on
 * unterminated openers: every `<style>` with no `</style>` after it makes the
 * lazy `[\s\S]*?` scan to end-of-string before failing, and the global
 * `replace` then retries at the next opener. Measured on
 * `"<script a>zzzzzzzzzz".repeat(n)`: 100 KB → 285 ms, 200 KB → 1150 ms,
 * 400 KB → 4608 ms, 800 KB → 17977 ms — a clean 4x per doubling. Email
 * bodies are remote-attacker-controlled and this runs synchronously on every
 * indexed message BEFORE any body cap applies, so that shape is a denial of
 * service, not a slow path.
 *
 * This scan is linear instead, and the two properties that make it so are:
 *
 *  - `cursor` and the opener regex's `lastIndex` only ever move FORWARD, so
 *    each character is visited O(1) times by the opener search; and
 *  - a close-tag search that reaches end-of-string without a hit marks that
 *    tag name EXHAUSTED. "No `</style>` after position p" implies no
 *    `</style>` after any later position either, so no subsequent `<style>`
 *    can pay for that scan again. With three names, at most three
 *    full-length failed scans over the whole input.
 *
 * An unterminated section is left in place (fail-open) rather than treated as
 * "hidden to end of document": truncating a message body on malformed markup
 * would destroy author content, which is strictly worse than indexing some
 * CSS.
 */
function stripHiddenSections(input: string): string {
  HIDDEN_SECTION_OPEN_RE.lastIndex = 0;
  const exhausted = new Set<string>();
  let out = "";
  let cursor = 0;
  let match = HIDDEN_SECTION_OPEN_RE.exec(input);
  while (match !== null) {
    const name = match[1]?.toLowerCase() as HiddenSectionName;
    const openEnd = match.index + match[0].length;
    let closeEnd = -1;
    if (!exhausted.has(name)) {
      const closeRe = HIDDEN_SECTION_CLOSE_RE[name];
      closeRe.lastIndex = openEnd;
      const close = closeRe.exec(input);
      if (close === null) {
        exhausted.add(name);
      } else {
        closeEnd = close.index + close[0].length;
      }
    }
    if (closeEnd === -1) {
      // Unterminated: keep the section, and resume scanning past its opener
      // so `lastIndex` still advances monotonically.
      HIDDEN_SECTION_OPEN_RE.lastIndex = openEnd;
    } else {
      out += `${input.slice(cursor, match.index)} `;
      cursor = closeEnd;
      HIDDEN_SECTION_OPEN_RE.lastIndex = closeEnd;
    }
    match = HIDDEN_SECTION_OPEN_RE.exec(input);
  }
  return out === "" ? input : out + input.slice(cursor);
}

/**
 * A `<` that starts no tag.
 *
 * `stripHtmlTagsToSpaces` enters tag mode at EVERY `<` and stays there until
 * the next `>`, so an ordinary comparison in author prose is not merely
 * mis-parsed, it DELETES text: `"<p>if a < b</p>"` loses `" b"` along with
 * the `</p>` that was swallowed as the "tag" — and the block boundary that
 * `</p>` would have produced is lost with it, so a following attribution line
 * gets glued onto the prose and `stripQuotedTail` can no longer see it.
 * `"if a < b"` is common in exactly the technical mail this module exists to
 * index, so the `<` is escaped here and restored by the entity decode below.
 *
 * A real tag name, a closing tag, a comment/doctype (`<!`) and a processing
 * instruction (`<?`) are the only things that may follow a genuine tag start.
 */
const STRAY_LT_RE = /<(?![A-Za-z/!?])/g;

/**
 * Character references, decoded AFTER tag stripping.
 *
 * Before this branch, Outlook indexed Graph's `bodyPreview`, which is already
 * DECODED plain text; indexing `body.content` instead means the raw entities
 * (`&nbsp;` above all) would otherwise reach the index verbatim — a body-
 * quality regression on the connector this feature targets. It also breaks
 * the trimmer: an HTML-quoted block rendered as `&gt; original` never matches
 * `stripQuotedTail`'s `QUOTE_RE`, so quoted-tail stripping never fires.
 *
 * Decoding must come AFTER `stripHtmlTagsToSpaces`, never before: an authored
 * `&lt;p&gt;` (a person writing about a `<p>` tag) would otherwise turn into
 * a real tag and be stripped as markup.
 *
 * Every quantifier is bounded and the alternation is disjoint on the first
 * character after `&#`, so there is nothing to backtrack over. An UNKNOWN
 * named entity is deliberately left literal — inert text is a better outcome
 * than a guess, and the five XML predefined names plus `&nbsp;` plus numeric
 * references cover what real mail actually carries.
 */
const ENTITY_RE = /&(?:#(?:[xX]([0-9a-fA-F]{1,6})|(\d{1,7}))|([a-zA-Z]{2,8}));/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // U+00A0, not a plain space: `collapseHorizontalWhitespace`'s `\s+` already
  // matches it, so it normalises to a space exactly like any other run.
  nbsp: " ",
};

function characterFromCodePoint(code: number, fallback: string): string {
  // Reject NUL, out-of-range, and lone surrogates — `String.fromCodePoint`
  // throws on the last two, and a NUL in indexed text helps nobody.
  if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return fallback;
  }
  return String.fromCodePoint(code);
}

function decodeCharacterReferences(line: string): string {
  return line.replace(
    ENTITY_RE,
    (
      whole: string,
      hex: string | undefined,
      dec: string | undefined,
      name: string | undefined,
    ): string => {
      if (hex !== undefined) {
        return characterFromCodePoint(Number.parseInt(hex, 16), whole);
      }
      if (dec !== undefined) {
        return characterFromCodePoint(Number.parseInt(dec, 10), whole);
      }
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
    },
  );
}

function collapseHorizontalWhitespace(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Collapse runs of blank lines to at most one, and trim leading/trailing blanks. */
function collapseBlankLineRuns(lines: readonly string[]): string[] {
  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const isBlank = line === "";
    if (isBlank && prevBlank) {
      continue;
    }
    out.push(line);
    prevBlank = isBlank;
  }
  while (out.length > 0 && out[0] === "") {
    out.shift();
  }
  while (out.length > 0 && out.at(-1) === "") {
    out.pop();
  }
  return out;
}

export function plainTextFromHtmlLines(raw: string): string {
  if (raw === "") {
    return "";
  }
  // Neutralise any pre-existing newline in the SOURCE markup (pretty-printed
  // HTML routinely soft-wraps inside a single logical block) before adding
  // any of our own — otherwise incidental source formatting would be
  // mistaken for an intentional block boundary.
  const normalizedRaw = raw.replace(/\r\n|\r|\n/g, " ");
  const visible = stripHiddenSections(normalizedRaw);
  const escaped = visible.replace(STRAY_LT_RE, "&lt;");
  const withBreaks = escaped.replace(BLOCK_BOUNDARY_RE, "\n");
  const stripped = stripHtmlTagsToSpaces(withBreaks);
  // Decode per LINE, after the split: a `&#10;` in the source is an authored
  // whitespace character, not a block boundary, and must collapse like one
  // rather than fabricate a structural line.
  const lines = stripped
    .split("\n")
    .map((line) => collapseHorizontalWhitespace(decodeCharacterReferences(line)));
  return collapseBlankLineRuns(lines).join("\n");
}
