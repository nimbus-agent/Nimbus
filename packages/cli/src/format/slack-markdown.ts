/**
 * Markdown → Slack `mrkdwn` and Markdown → plain-text transforms.
 *
 * These operate on the rendered Markdown STRING a brief already produced, never on the typed
 * `findings` object — synthesis may have rewritten the brief into prose, and re-rendering from
 * `findings` would silently discard that prose. See `packages/cli/src/commands/changelog.ts`.
 *
 * Neither function reads `findings`; both are pure string → string.
 */

/**
 * A Markdown inline link whose TITLE may contain BACKSLASH-ESCAPED brackets.
 *
 * The naive title class `[^\]]*` is wrong against the briefs this tool actually consumes: the
 * gateway renderer hardens every entry title through `escapeMarkdownLinkText`
 * (`agents/_lib/render.ts`), which turns `[` into `\[`, `]` into `\]` and `\` into `\\`. A class
 * that stops at the `]` CHARACTER stops at the `\]` too, so the whole link fails to match and
 * ships unconverted — a raw `[title](url)` posted into Slack, and a bare URL in the plain-text
 * output this module's own contract says must not carry one. `[WIP]`, `[RFC]`, `[hotfix]`,
 * `[P1]` and `[PROJ-123]` are routine PR/incident title prefixes, so it fails silently on real
 * changelogs rather than on a contrived one.
 *
 * The two branches are UNAMBIGUOUS — `\\[\s\S]` can only start at a backslash and
 * `[^\\\]]` can only start at a non-backslash — so no input can be split between them two ways
 * and there is no backtracking blow-up. `slack-markdown.test.ts` pins that with a time-bounded
 * case, because "this alternation is disjoint" is exactly the claim a future edit breaks
 * silently.
 */
const LINK_RE = /\[((?:\\[\s\S]|[^\\\]])*)\]\(([^)]+)\)/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;

/**
 * Undoes `escapeMarkdownLinkText`: `\\` → `\`, `\[` → `[`, `\]` → `]`.
 *
 * This is needed INDEPENDENTLY of {@link LINK_RE}, and that is why it is a whole-line pass
 * rather than something {@link convertLink} does to the title it captured. The renderer escapes
 * an entry title whether or not a link ends up wrapping it — an item with no renderable
 * permalink renders as bare escaped text — so a title-only unescape would still ship
 * `\[WIP\] Fix auth` to a reader. Running it once, LAST, also keeps it from double-unescaping:
 * a title carrying a literal backslash arrives as `\\\[` and must become `\[`, not `[`.
 *
 * It must stay last for a second reason: it is the inverse of the escaping {@link LINK_RE}
 * reads, so unescaping first would hand the link matcher live brackets and reintroduce the
 * truncation the escaping exists to prevent.
 */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\[\]])/g, "$1");
}

/**
 * Underscore italic requires a word boundary on both sides of the delimiter pair, mirroring
 * CommonMark's intraword-underscore restriction: `\w` (which includes `_` itself) must NOT be
 * adjacent to either delimiter. Without this, a bare `/_(.+?)_/` treats every underscore pair
 * inside an identifier as an italic run — `Fix MAX_SINCE_MS bound` would lose an underscore
 * (`MAXSINCE_MS`). PR titles and commit messages in this codebase are dense with
 * `SCREAMING_SNAKE_CASE`, so this is not a theoretical case.
 *
 * Single-asterisk italic gets no such guard: CommonMark allows `*` to open/close emphasis
 * intraword, so `*i*` mid-word is legitimate and `ASTERISK_ITALIC_RE` is unrestricted.
 */
const UNDERSCORE_ITALIC_RE = /(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g;
const ASTERISK_ITALIC_RE = /\*(.+?)\*/g;
const HEADING_RE = /^#{1,6}[ \t]+(.*)$/;
const STRIKE_RE = /~~(.+?)~~/g;

/**
 * Sentinel wrapper for a converted bold run: two DISTINCT Unicode Private Use Area code points
 * (U+E000 / U+E001). The PUA is reserved by the Unicode standard for private application use and
 * is never assigned a character meaning, a glyph a keyboard can type, or a sequence that would
 * appear in real Markdown/prose — so the claim "cannot occur in Markdown source" holds. Earlier
 * revisions of this sentinel used NUL bytes (U+0000), which are equally impossible to type but
 * make the FILE ITSELF register as binary to git/GitHub (confirmed: `git diff` showed "Bin file
 * changed" instead of a readable diff, and `file` reported "data" instead of "UTF-8 text") —
 * exactly the kind of tooling trap that cost a reviewer time reading this file's raw bytes to
 * confirm what the sentinel actually was. PUA code points are ordinary (if unassigned) Unicode
 * text, so the source file stays plain UTF-8 and diffs normally.
 *
 * Bold is converted to Slack's SINGLE-asterisk syntax, but the italic pass that follows also
 * matches single asterisks — running it straight after bold would immediately re-match `*b*` as
 * an italic run and corrupt it back down to `_b_`. Parking the converted run behind a sentinel
 * until AFTER the italic pass runs is what keeps the two passes from interleaving; see the "bold
 * nested inside a link title" test, which is the case this exists for.
 */
const BOLD_OPEN = "";
const BOLD_CLOSE = "";

const TABLE_ROW_RE = /^\s*\|(.*)\|\s*$/;
const DELIMITER_CELL_RE = /^:?-+:?$/;

/** `undefined` when `line` is not a pipe-delimited table row at all (not just an empty table). */
function tableRowCells(line: string): string[] | undefined {
  const m = TABLE_ROW_RE.exec(line);
  if (m === null) return undefined;
  return (m[1] ?? "").split("|").map((c) => c.trim());
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL_RE.test(c));
}

type InlineMode = "slack" | "plain";

function convertLink(text: string, mode: InlineMode): string {
  return text.replace(LINK_RE, (_m, title: string, url: string) =>
    mode === "slack" ? `<${url}|${title}>` : title,
  );
}

/**
 * Bold before italic is the one load-bearing order in this pipeline (see {@link BOLD_OPEN}).
 * Link conversion is NOT order-dependent against this pair: `[t](u)` and `**b**`/`*i*`/`_i_`
 * match independently of each other (`LINK_RE` cares about `[`/`]`/`(`/`)`, the emphasis regexes
 * care about `*`/`_`), so converting links before or after this step produces byte-identical
 * output either way — hand-traced against `[**hot**fix](url)` and `[a **b** c](url)`.
 */
function convertBoldItalic(text: string, mode: InlineMode): string {
  if (mode === "plain") {
    let s = text.replace(BOLD_RE, (_m, b: string) => b);
    s = s.replace(UNDERSCORE_ITALIC_RE, (_m, i: string) => i);
    s = s.replace(ASTERISK_ITALIC_RE, (_m, i: string) => i);
    return s;
  }
  let s = text.replace(BOLD_RE, (_m, b: string) => `${BOLD_OPEN}${b}${BOLD_CLOSE}`);
  s = s.replace(ASTERISK_ITALIC_RE, (_m, i: string) => `_${i}_`);
  return s.replaceAll(BOLD_OPEN, "*").replaceAll(BOLD_CLOSE, "*");
}

function convertStrike(text: string, mode: InlineMode): string {
  return text.replace(STRIKE_RE, (_m, x: string) => (mode === "slack" ? `~${x}~` : x));
}

/**
 * The shared inline pipeline, run once per ordinary line and once per table cell.
 *
 * {@link unescapeMarkdown} is last by requirement, not by taste — see its doc comment.
 */
function convertInline(text: string, mode: InlineMode): string {
  return unescapeMarkdown(convertStrike(convertBoldItalic(convertLink(text, mode), mode), mode));
}

/**
 * `undefined` when `line` should be dropped entirely (the `| --- |` delimiter row) — distinct
 * from an empty-string result, which would leave a blank line behind.
 *
 * Table cells are split from the RAW line, before `convertInline` ever runs on them: `[t](u)` →
 * `<u|t>` injects a `|`, so splitting cells AFTER link conversion (the previous shape of this
 * code) would misread that injected pipe as a cell boundary and corrupt a link inside a table
 * cell — `| [PR](url) | merged |` would split into three cells instead of two. Splitting first
 * and converting each cell independently makes that collision structurally impossible: a cell's
 * own inline conversion can inject as many `|` characters as it likes without affecting how the
 * row was divided.
 */
function transformLine(line: string, mode: InlineMode): string | undefined {
  const cells = tableRowCells(line);
  if (cells !== undefined) {
    if (isDelimiterRow(cells)) return undefined;
    const bulletPrefix = mode === "slack" ? "• " : "";
    return `${bulletPrefix}${cells.map((c) => convertInline(c, mode)).join(" | ")}`;
  }

  const heading = HEADING_RE.exec(line);
  if (heading !== null) {
    const body = convertInline(heading[1] ?? "", mode);
    return mode === "slack" ? `*${body}*` : body;
  }

  return convertInline(line, mode);
}

function transformMarkdown(markdown: string, mode: InlineMode): string {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const transformed = transformLine(line, mode);
    if (transformed !== undefined) out.push(transformed);
  }
  return out.join("\n");
}

/**
 * Markdown → Slack `mrkdwn`. Headings become bold lines, strikethrough collapses to a single
 * tilde, links become `<url|title>`, bold becomes single-asterisk, and table rows become
 * `• cell | cell` lines (Slack renders no tables at all) with the delimiter row dropped. See
 * {@link transformLine} for the table/cell-splitting rationale and {@link convertBoldItalic}
 * for the one load-bearing ordering rule in the inline pipeline.
 */
export function toSlackMrkdwn(markdown: string): string {
  return transformMarkdown(markdown, "slack");
}

/**
 * Markdown → plain text. The same structural pass as {@link toSlackMrkdwn}, but every marker is
 * STRIPPED rather than converted: a link keeps its title and drops the URL (a plain-text
 * changelog pasted into an email should not carry bare URLs), every emphasis marker is removed
 * (see {@link UNDERSCORE_ITALIC_RE} for the word-boundary rule that keeps this from mangling
 * `SCREAMING_SNAKE_CASE` identifiers), and list hyphens are left alone since they already read
 * correctly as-is.
 */
export function toPlainText(markdown: string): string {
  return transformMarkdown(markdown, "plain");
}
