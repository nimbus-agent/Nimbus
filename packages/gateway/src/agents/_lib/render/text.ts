/**
 * Escapes a citation title for the `[...]` position of a Markdown link.
 *
 * ONE pass over a character class that INCLUDES the backslash — deliberately not a chain of
 * `.replace(/\[/g, "\\[").replace(/\]/g, "\\]")`. That chain is order-dependent and wrong:
 * a title containing `\[` has its bracket escaped to `\\[`, where the doubled backslash
 * renders as a literal backslash and the bracket is live again, breaking out of the link
 * text. Item titles are EXTERNAL input (a PR title, an issue title, a decision statement),
 * so "no one would write that" is not an argument. CodeQL `js/incomplete-sanitization`
 * caught exactly this. Escaping the escape character first — or in the same pass — is the
 * only correct shape.
 */
export function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * The `(...)` target of a citation link, or `null` when the url cannot be rendered safely.
 *
 * Two separate guards, both fail-safe toward plain text:
 *
 * 1. **Scheme allow-list.** A connector-supplied `canonical_url` is external input, and this
 *    brief is rendered in the Tauri renderer — a `javascript:` or `data:` target would be a
 *    live script-execution vector with only the CSP (I8) behind it. Written as what MAY pass,
 *    never as a list of what may not.
 * 2. **Delimiter encoding.** `(`, `)` and whitespace terminate the target in Markdown, so a
 *    url containing them would truncate the link and spill the remainder into the document
 *    as text — worst case pointing the citation somewhere other than the evidence.
 *
 * The parens are encoded from an explicit map, NOT via `encodeURIComponent`: that function
 * leaves `(`, `)`, `!`, `'` and `*` untouched — they are "unreserved marks" in its spec — so
 * `encodeURIComponent(")")` returns `)` and the guard would be silently inert for the two
 * characters it exists to neutralise. Whitespace is the one case `encodeURIComponent` does
 * handle, and the `URL` parser has usually already encoded it.
 */
const HREF_DELIMITER_ESCAPES: Readonly<Record<string, string>> = { "(": "%28", ")": "%29" };

export function safeEvidenceHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href.replace(/[()\s]/g, (c) => HREF_DELIMITER_ESCAPES[c] ?? encodeURIComponent(c));
}

/**
 * Every character that can END A LINE (or reorder one) inside a Markdown document, dropped.
 *
 * `escapeMarkdownLinkText` hardens brackets and backslashes and nothing else, which is correct
 * for its own job and insufficient on its own here: a title is arbitrary connector-supplied text
 * (`index/item-store.ts` stores `item.title` verbatim — no connector or writer strips control
 * characters from it), so a PR or incident subject containing `\n## Gaps` ends the entry's list
 * item and renders the remainder as a LEVEL-2 HEADING of its own. That plants a fabricated
 * section — potentially a reserved one — in the deterministic render, which is the artifact I31
 * exists to keep honest. `changelogScopeLabel` below already makes this exact argument for
 * `--service`, which is merely OWNER-supplied; the entry title is the stronger case, not the
 * weaker one.
 *
 * Dropped rather than substituted, for `changelogScopeLabel`'s reason: a replacement character
 * is a second thing the reader has to interpret, and nothing legitimate arrives carrying one.
 * `\p{Cc}` covers CR/LF and the C0/C1 controls, `\p{Cf}` the bidi overrides and zero-width
 * joiners, `\p{Zl}`/`\p{Zp}` U+2028 and U+2029.
 */
export function stripLineStructureChars(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

/**
 * A connector-supplied title, linked when its url can be rendered safely and plain otherwise —
 * never a link to nowhere.
 *
 * Both halves go through `negotiate`'s hardened helpers rather than being interpolated raw,
 * because BOTH halves are connector-supplied: the title is a pull-request or incident subject
 * written by whoever opened it, and the url is a connector's `canonical_url`. A title
 * containing `](` closes the link early and takes the rest of the line with it, and a
 * `javascript:` target is live in the Tauri renderer with only the CSP (I8) behind it.
 * `renderWhy` and `renderDecisionsEvidenceItem` interpolate raw; that is the older shape, not
 * the one to copy.
 *
 * The ONE copy of this hardening for the entry renderer below and every `oncall` title (a
 * url-less runner-up passes `null` and gets the hardened plain text), for the reason
 * {@link RenderableEntry} gives: it is security-relevant, and each inline copy of it is one more
 * place for it to drift.
 */
export function hardenedTitleLink(title: string, url: string | null): string {
  const text = escapeMarkdownLinkText(stripLineStructureChars(title));
  const href = url === null ? null : safeEvidenceHref(url);
  return href === null ? text : `[${text}](${href})`;
}

/**
 * Indexed text shown as PLAIN text (a mail sender, a status, a repository name): line structure and
 * backticks stripped, capped at `max` characters, and escaped so it can neither close a link nor
 * open one. For text that is not a link title, where {@link hardenedTitleLink} does not apply.
 */
export function hardenedPlain(text: string, max = 80): string {
  const s = stripLineStructureChars(text).replaceAll("`", "");
  return escapeMarkdownLinkText(s.length > max ? `${s.slice(0, max)}…` : s);
}
