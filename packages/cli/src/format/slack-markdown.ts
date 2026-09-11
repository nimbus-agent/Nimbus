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
 * Undoes `escapeMarkdownLinkText`: `\\` → `\`, `\[` → `[`, `\]` → `]`. `\|` → `|` rides along:
 * the renderer never emits it, but a SYNTHESIZED rewrite writing a GFM table escapes a pipe
 * inside a cell that way, and {@link splitUnescapedPipes} preserves the sequence through the
 * cell split precisely so this pass can resolve it to the character the reader should see.
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
  return text.replace(/\\([\\[\]|])/g, "$1");
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
 * Single-asterisk italic that is NOT half of a `**bold**` run: a delimiter with no asterisk on
 * its outer side, on both ends.
 *
 * This exists so bold can be converted LAST. Bold becomes Slack's SINGLE-asterisk syntax, so a
 * naive italic pass running after it re-matches `*b*` and corrupts it back to `_b_`; an earlier
 * revision solved that by parking each converted bold run between two Unicode Private Use Area
 * sentinels (U+E000 / U+E001) and `replaceAll`-ing them back to `*` at the end. That was wrong
 * in a way "cannot occur in Markdown source" concealed: the input is not Markdown SOURCE, it is a
 * brief built from connector-supplied text — a PR or incident title anyone can write — so a
 * literal U+E000 arriving in a title was rewritten to a `*` that Slack then reads as a live
 * emphasis delimiter. Ordering the passes so no placeholder is needed removes the collision
 * rather than picking a rarer character to collide on.
 */
const ASTERISK_ITALIC_NOT_BOLD_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;

const TABLE_ROW_RE = /^\s*\|(.*)\|\s*$/;
const DELIMITER_CELL_RE = /^:?-+:?$/;

/**
 * Cell boundaries, honouring GFM's `\|` escape.
 *
 * A plain `.split("|")` also splits an ESCAPED pipe, so `| A \| B | merged |` divides into three
 * cells instead of two and the row ships with a fabricated column. A `(?<!\\)\|` lookbehind is
 * the obvious one-liner and is wrong on `\\|` — an escaped BACKSLASH followed by a real
 * separator — because the lookbehind sees the second backslash and calls the pipe escaped. A
 * left-to-right scan that consumes each `\x` pair as a unit is the only shape that gets both
 * cases right, so this is a loop rather than a regex.
 *
 * The `\|` sequence is left INTACT in the returned cell; {@link unescapeMarkdown}, which already
 * runs last on every cell, resolves it to `|`.
 */
function splitUnescapedPipes(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < row.length; i++) {
    const c = row[i] ?? "";
    if (c === "\\" && i + 1 < row.length) {
      cur += c + (row[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

/** `undefined` when `line` is not a pipe-delimited table row at all (not just an empty table). */
function tableRowCells(line: string): string[] | undefined {
  const m = TABLE_ROW_RE.exec(line);
  if (m === null) return undefined;
  return splitUnescapedPipes(m[1] ?? "").map((c) => c.trim());
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
 * The one load-bearing order in this pipeline, and it differs by mode.
 *
 * PLAIN strips every marker, so nothing a pass emits can be re-matched by the next; bold runs
 * first only because `**b**` must not be seen as two adjacent empty italic runs.
 *
 * SLACK converts italic FIRST — with {@link ASTERISK_ITALIC_NOT_BOLD_RE}, which steps over a
 * `**` delimiter rather than consuming half of one — and bold second. Bold's output (`*b*`) is
 * then never offered to the italic pass, which is the collision the PUA sentinels used to
 * absorb. Hand-traced against `[**hot**fix](url)`, `*a **b** c*` and `**b** and *i*`, all three
 * byte-identical to the sentinel version.
 *
 * Link conversion is NOT order-dependent against this pair: `[t](u)` and `**b**`/`*i*`/`_i_`
 * match independently of each other (`LINK_RE` cares about `[`/`]`/`(`/`)`, the emphasis regexes
 * care about `*`/`_`), so converting links before or after this step produces byte-identical
 * output either way.
 */
function convertBoldItalic(text: string, mode: InlineMode): string {
  if (mode === "plain") {
    let s = text.replace(BOLD_RE, (_m, b: string) => b);
    s = s.replace(UNDERSCORE_ITALIC_RE, (_m, i: string) => i);
    s = s.replace(ASTERISK_ITALIC_RE, (_m, i: string) => i);
    return s;
  }
  const s = text.replace(ASTERISK_ITALIC_NOT_BOLD_RE, (_m, i: string) => `_${i}_`);
  return s.replace(BOLD_RE, (_m, b: string) => `*${b}*`);
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
