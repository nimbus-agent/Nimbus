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
 * This module inserts a newline at each recognised HTML block boundary
 * BEFORE handing off to the existing (frozen, unmodified) `stripHtmlTagsToSpaces`,
 * then normalises horizontal whitespace within each resulting line and
 * collapses runs of blank lines — without ever merging two structural lines
 * into one.
 *
 * `plainTextFromHtml`, `collapseWhitespace`, and `stripHtmlTagsToSpaces`
 * (`html-plain-text.ts`) are NOT modified here; their other consumers must
 * stay bit-identical.
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
 */
const BLOCK_BOUNDARY_RE =
  /<\/li\s*>\s*<li(?:\s[^>]*)?>|<\/(?:p|div|tr|li|h[1-6]|blockquote)\s*>|<br(?:\s[^>]*)?\/?>|<li(?:\s[^>]*)?>/gi;

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
  while (out.length > 0 && out[out.length - 1] === "") {
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
  const withBreaks = normalizedRaw.replace(BLOCK_BOUNDARY_RE, "\n");
  const stripped = stripHtmlTagsToSpaces(withBreaks);
  const lines = stripped.split("\n").map(collapseHorizontalWhitespace);
  return collapseBlankLineRuns(lines).join("\n");
}
