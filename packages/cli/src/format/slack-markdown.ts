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
 * Where a Markdown inline link's TITLE closes: the index of the first UNESCAPED `]` at or after
 * `start` (just past the opening `[`), or `undefined` when the title never closes.
 *
 * The title may contain BACKSLASH-ESCAPED brackets, and stopping at the first `]` CHARACTER is
 * wrong against the briefs this tool actually consumes: the gateway renderer hardens every entry
 * title through `escapeMarkdownLinkText` (`agents/_lib/render.ts`), which turns `[` into `\[`,
 * `]` into `\]` and `\` into `\\`. A scan that stops at the `]` of a `\]` makes the whole link fail
 * to match and ship unconverted — a raw `[title](url)` posted into Slack, and a bare URL in the
 * plain-text output this module's own contract says must not carry one. `[WIP]`, `[RFC]`,
 * `[hotfix]`, `[P1]` and `[PROJ-123]` are routine PR/incident title prefixes, so that fails
 * silently on real changelogs rather than on a contrived one. A `\x` pair is therefore consumed as
 * one unit whatever `x` is — an escaped `]` included — and a lone trailing backslash escapes
 * nothing, so it cannot close the title either.
 */
function closingTitleBracket(text: string, start: number): number | undefined {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "]") return i;
    i += c === "\\" ? 2 : 1;
  }
  return undefined;
}

type LinkScan = {
  readonly resumeAt: number;
  readonly link?: { readonly title: string; readonly url: string };
};

/**
 * One attempt to read `[title](url)` with its `[` at `open`. `resumeAt` is where the search for
 * the next link continues: just past the link when one matched, otherwise the first index that
 * could still START one.
 *
 * Skipping ahead on a failed attempt is what keeps a whole line linear, and it is exact rather
 * than a heuristic. Every `[` between `open` and the title's closing `]` sits inside that title, at
 * a point where its scan is in step with this one (an escape pair is consumed whole), so an attempt
 * starting there would reach the SAME `]` and fail the same way — the single regex this scan
 * replaced retried each of them anyway, which made `[](` repeated without a `)` quadratic.
 * Likewise when no `)` follows `](` at all, nothing later in the line can close a link, and when
 * the title never closes, no later `[` can close one either. The URL is everything up to the FIRST
 * `)` and must be non-empty, so `[t]()` is not a link. Match for match, the output is what that
 * regex produced; `slack-markdown.test.ts` quotes it and pins the equivalence cases and the time
 * bound.
 */
function scanLink(text: string, open: number): LinkScan {
  const close = closingTitleBracket(text, open + 1);
  if (close === undefined) return { resumeAt: text.length };
  if (text[close + 1] !== "(") return { resumeAt: close + 1 };
  const urlEnd = text.indexOf(")", close + 2);
  if (urlEnd === -1) return { resumeAt: text.length };
  if (urlEnd === close + 2) return { resumeAt: close + 1 };
  return {
    resumeAt: urlEnd + 1,
    link: { title: text.slice(open + 1, close), url: text.slice(close + 2, urlEnd) },
  };
}

const BOLD_RE = /\*\*(.+?)\*\*/g;

/**
 * Undoes `escapeMarkdownLinkText`: `\\` → `\`, `\[` → `[`, `\]` → `]`. `\|` → `|` rides along:
 * the renderer never emits it, but a SYNTHESIZED rewrite writing a GFM table escapes a pipe
 * inside a cell that way, and {@link splitUnescapedPipes} preserves the sequence through the
 * cell split precisely so this pass can resolve it to the character the reader should see.
 *
 * This is needed INDEPENDENTLY of the link scan ({@link scanLink}), and that is why it is a
 * whole-line pass rather than something {@link convertLink} does to the title it captured. The
 * renderer escapes an entry title whether or not a link ends up wrapping it — an item with no
 * renderable permalink renders as bare escaped text — so a title-only unescape would still ship
 * `\[WIP\] Fix auth` to a reader. Running it once, LAST, also keeps it from double-unescaping:
 * a title carrying a literal backslash arrives as `\\\[` and must become `\[`, not `[`.
 *
 * It must stay last for a second reason: it is the inverse of the escaping
 * {@link closingTitleBracket} reads, so unescaping first would hand the link matcher live
 * brackets and reintroduce the truncation the escaping exists to prevent.
 */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\[\]|])/g, "$1");
}

/**
 * The three character classes the underscore-italic pass reads — `\w`, `\s`, and the `.` of its
 * content — written as the very escapes the regex it replaced used, with the same (absent) flags.
 * Tested against one UTF-16 code unit, each answers exactly as that regex's atom did: `é` is not a
 * word character, U+00A0 is a space, `.` refuses only the line terminators `\n`, `\r`, U+2028 and
 * U+2029, and each half of a surrogate pair is a separate non-word, non-space code unit. Keep them
 * as these escapes rather than sets written out by hand: `\s` also covers U+1680, U+2000 to U+200A,
 * U+202F and U+205F, which a list written from memory tends to miss, and U+0085 is neither a space
 * nor a line terminator here, unlike in Python's `\s` or Java's `.`. `slack-markdown.test.ts` puts
 * every code unit at each place the pattern reads one.
 */
const WORD_RE = /\w/;
const SPACE_RE = /\s/;
const DOT_RE = /./;

/**
 * Whether `re` matches the code unit at `i`. Outside the text `charAt` returns `""`, which none of
 * the three classes matches: the answer a lookaround gives at either end, where `(?<!\w)` and
 * `(?!\w)` both hold.
 */
function codeUnitMatches(re: RegExp, text: string, i: number): boolean {
  return re.test(text.charAt(i));
}

/**
 * Whether the `_` at `open` can OPEN an underscore-italic run: no word character before it, and a
 * content code unit after it that is not a space — `(?<!\w)_(?!\s)` and the first unit of `(.+?)`.
 * The caller has already found the `_`.
 */
function opensUnderscoreItalic(text: string, open: number): boolean {
  return (
    !codeUnitMatches(WORD_RE, text, open - 1) &&
    !codeUnitMatches(SPACE_RE, text, open + 1) &&
    codeUnitMatches(DOT_RE, text, open + 1)
  );
}

/**
 * Whether the code unit at `i` can CLOSE one: an `_` with no space before it and no word character
 * after it — `(?<!\s)_(?!\w)`. Nothing here depends on where the run opened, which is what lets
 * {@link scanUnderscoreItalic} skip ahead.
 */
function closesUnderscoreItalic(text: string, i: number): boolean {
  return (
    text[i] === "_" &&
    !codeUnitMatches(SPACE_RE, text, i - 1) &&
    !codeUnitMatches(WORD_RE, text, i + 1)
  );
}

type UnderscoreScan = { readonly resumeAt: number; readonly close?: number };

/**
 * One attempt to read `_content_` with its opening `_` at `open`, in the order the lazy `(.+?)`
 * tried it: past the first content unit, close at `i` when an `_` there can close, otherwise take
 * `i` into the content — which a line terminator refuses, ending the attempt. `resumeAt` is where
 * the search for the next run continues: just past the closing `_` when one matched, otherwise the
 * first index at which a run could still start.
 *
 * Skipping ahead on a failed attempt is what keeps a line linear, and, as in {@link scanLink}, it
 * is exact rather than a heuristic. Whether an `_` can close never depends on where its run opened,
 * so once this attempt reaches a line terminator, or the end of the text, without finding a
 * closer, every closer that a later `_` before that point could use lies in the stretch this
 * attempt has already searched, and none of those `_` can open a run either. The regex this scan
 * replaced retried each of them anyway, which made a line of `_` that open but never close
 * quadratic: ` _a` repeated, where the space before each `_` and the word character after it each
 * rule out a close.
 */
function scanUnderscoreItalic(text: string, open: number): UnderscoreScan {
  if (!opensUnderscoreItalic(text, open)) return { resumeAt: open + 1 };
  for (let i = open + 2; i < text.length; i++) {
    if (closesUnderscoreItalic(text, i)) return { resumeAt: i + 1, close: i };
    if (!codeUnitMatches(DOT_RE, text, i)) return { resumeAt: i + 1 };
  }
  return { resumeAt: text.length };
}

/**
 * Plain mode's underscore pass: every underscore-italic run in `text`, leftmost first, replaced by
 * its content.
 *
 * Underscore italic requires a word boundary on both sides of the delimiter pair, mirroring
 * CommonMark's intraword-underscore restriction: `\w` (which includes `_` itself) must NOT be
 * adjacent to either delimiter. Without this, a bare `/_(.+?)_/` treats every underscore pair
 * inside an identifier as an italic run — `Fix MAX_SINCE_MS bound` would lose an underscore
 * (`MAXSINCE_MS`). PR titles and commit messages in this codebase are dense with
 * `SCREAMING_SNAKE_CASE`, so this is not a theoretical case.
 *
 * Single-asterisk italic gets no such guard: CommonMark allows `*` to open/close emphasis
 * intraword, so `*i*` mid-word is legitimate and `ASTERISK_ITALIC_RE` is unrestricted.
 *
 * This pass was `text.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, (_m, i) => i)`, and it returns
 * what that returned for every input — the same runs, matched left to right without overlap, with
 * every lookaround reading the ORIGINAL text — in time linear in the line rather than quadratic.
 * Exported for `slack-markdown.test.ts`, which keeps that regex as the oracle it compares against
 * and pins the time bound.
 */
export function stripUnderscoreItalic(text: string): string {
  let out = "";
  let copied = 0;
  let open = text.indexOf("_");
  while (open !== -1) {
    const { resumeAt, close } = scanUnderscoreItalic(text, open);
    if (close !== undefined) {
      out += text.slice(copied, open) + text.slice(open + 1, close);
      copied = resumeAt;
    }
    open = text.indexOf("_", resumeAt);
  }
  return out + text.slice(copied);
}

const ASTERISK_ITALIC_RE = /\*(.+?)\*/g;
/**
 * `#`–`######`, a run of spaces/tabs, then the heading text — captured WITHOUT its leading
 * whitespace, and absent (not `""`) for a heading with no text, which the caller reads as `""`.
 *
 * The text's first character is any character `.` matches EXCEPT a space or a tab, so it can
 * never be handed back to the separator run. Written as `[ \t]+(.*)`, the two could trade
 * characters: a line that cannot match — a `\r` before its end, which `.` refuses and `$` (no `m`
 * flag) does not accept — re-scanned the rest of the line once per separator character, quadratic
 * in the length of the run. The set of lines that match is unchanged, and so is the text every
 * heading renders.
 */
const HEADING_RE = /^#{1,6}[ \t]+([^ \t\n\r\u2028\u2029].*)?$/;
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

/**
 * Every `[title](url)` in `text`, leftmost first, as `<url|title>` (Slack) or the bare `title`
 * (plain). Text outside a link is copied through untouched.
 */
function convertLink(text: string, mode: InlineMode): string {
  let out = "";
  let copied = 0;
  let open = text.indexOf("[");
  while (open !== -1) {
    const { resumeAt, link } = scanLink(text, open);
    if (link !== undefined) {
      out +=
        text.slice(copied, open) + (mode === "slack" ? `<${link.url}|${link.title}>` : link.title);
      copied = resumeAt;
    }
    open = text.indexOf("[", resumeAt);
  }
  return out + text.slice(copied);
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
 * match independently of each other (the link scan cares about `[`/`]`/`(`/`)`, the emphasis
 * passes care about `*`/`_`), so converting links before or after this step produces
 * byte-identical output either way.
 */
function convertBoldItalic(text: string, mode: InlineMode): string {
  if (mode === "plain") {
    let s = text.replace(BOLD_RE, (_m, b: string) => b);
    s = stripUnderscoreItalic(s);
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
 * (see {@link stripUnderscoreItalic} for the word-boundary rule that keeps this from mangling
 * `SCREAMING_SNAKE_CASE` identifiers), and list hyphens are left alone since they already read
 * correctly as-is.
 */
export function toPlainText(markdown: string): string {
  return transformMarkdown(markdown, "plain");
}

/**
 * The `--format` values a brief command (`changelog`, `standup`) accepts: text transforms over
 * the brief's own Markdown, never a re-render from its findings.
 */
export type BriefTextFormat = "markdown" | "slack" | "plain";

const BRIEF_TEXT_FORMATS: ReadonlySet<string> = new Set<BriefTextFormat>([
  "markdown",
  "slack",
  "plain",
]);

export function isBriefTextFormat(v: string): v is BriefTextFormat {
  return BRIEF_TEXT_FORMATS.has(v);
}

/**
 * Applies one `--format` transform to a brief's Markdown; `markdown` passes it through verbatim.
 * The switch is total over {@link BriefTextFormat}, so a fourth format fails to compile here
 * rather than silently printing Markdown.
 */
export function formatBriefText(markdown: string, format: BriefTextFormat): string {
  switch (format) {
    case "slack":
      return toSlackMrkdwn(markdown);
    case "plain":
      return toPlainText(markdown);
    case "markdown":
      return markdown;
  }
}
