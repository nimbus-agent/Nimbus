/**
 * The ONE place a Dependabot PR's description is turned into the squash-commit body this repo
 * lands for it. Two consumers read it and must agree byte-for-byte:
 *
 *   - `scripts/dependabot/shepherd.ts` WRITES the summary onto the PR (then enables auto-merge),
 *     so the summary is the body GitHub squashes.
 *   - `scripts/release/check-pr-message-parses.ts` JUDGES the summary rather than the raw body
 *     for a PR authored by Dependabot, so the Release-safety gate checks the body that will
 *     actually land instead of one that is about to be replaced.
 *
 * Why a summary at all: Dependabot's description quotes upstream release notes verbatim, the
 * PR body IS the squash commit's body, and release-please's commit parser throws on an
 * unbalanced `(` — dropping the commit from the changelog. Dependabot bodies tripped that gate
 * on #1574 and #1580/#1582 (2026-09-29/30). The shepherd cannot fix the quoted notes, so it
 * replaces them with a list of what actually changed.
 *
 * Dependency-free on purpose (no `@conventional-commits/parser` import): the shepherd runs in a
 * workflow that does not `bun install`.
 */

/** One `name: from -> to` change, as Dependabot reported it. */
export interface DependencyBump {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/**
 * First line of every body this module writes. It makes normalisation idempotent — a body that
 * starts with it is re-parsed from its own `- ` lines, never summarised again — and tells a
 * reader the text was rewritten.
 */
export const SUMMARY_MARKER = "<!-- nimbus:dependabot-summary -->";

/**
 * Whether a PR author login is Dependabot. GitHub spells it TWO ways depending on the API, and
 * each consumer here sees a different one: the REST webhook payload the Release-safety gate
 * reads (`github.event.pull_request.user.login`) says `dependabot[bot]`, while `gh pr list
 * --json author` — GraphQL, which the shepherd reads — says `app/dependabot`. Matching only
 * the first made the shepherd classify every real Dependabot PR as "not authored by Dependabot"
 * when run over this repo's own history; the unit fixtures had used the REST spelling.
 */
export function isDependabotLogin(login: string | undefined): boolean {
  return login === "dependabot[bot]" || login === "app/dependabot";
}

// npm group table row:        | [name](url) | `1.0.0` | `1.1.0` |
const TABLE_ROW = /^\| \[([^\]]+)\]\([^)]*\) \| `([^`]+)` \| `([^`]+)` \|/;
// cargo / actions groups:     Updates `name` from 1.0.0 to 1.1.0
const UPDATES_LINE = /^Updates `([^`]+)` from (\S+) to (\S+?)\.?$/;
// single-package npm/cargo:   Bumps [name](url) from 1.0.0 to 1.1.0.
const BUMPS_LINE = /^Bumps \[([^\]]+)\]\([^)]*\) from (\S+) to (\S+?)\.?$/;
// our own summary lines:      - `name` 1.0.0 -> 1.1.0
const SUMMARY_LINE = /^- `([^`]+)` (\S+) -> (\S+)$/;
// title fallback:             chore(deps): bump name from 1.0.0 to 1.1.0 [in /dir]
const TITLE = /\bbump (\S+) from (\S+) to (\S+?)(?: in \S+)?$/i;

/**
 * Every bump the PR carries, de-duplicated by name, in first-seen order. Empty when nothing
 * recognisable is present — callers must treat that as "leave this PR alone", never as "no
 * changes".
 */
export function parseBumps(title: string, body: string): DependencyBump[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const patterns =
    lines[0]?.trim() === SUMMARY_MARKER ? [SUMMARY_LINE] : [TABLE_ROW, UPDATES_LINE, BUMPS_LINE];
  const seen = new Map<string, DependencyBump>();
  for (const raw of lines) {
    const line = raw.trim();
    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
        if (!seen.has(m[1])) seen.set(m[1], { name: m[1], from: m[2], to: m[3] });
        break;
      }
    }
  }
  if (seen.size === 0) {
    const m = TITLE.exec(title.trim());
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      seen.set(m[1], { name: m[1], from: m[2], to: m[3] });
    }
  }
  return [...seen.values()];
}

/** Leading numeric components of a version string: `v4.38.1` -> [4, 38, 1]. */
function numericParts(version: string): number[] | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (m?.[1] === undefined) return undefined;
  return [m[1], m[2] ?? "0", m[3] ?? "0"].map(Number);
}

/**
 * Whether a bump can break a consumer under semver: the major moved, or — below 1.0.0, where
 * semver promises nothing across minors — the minor moved. A version it cannot read counts as
 * breaking, because the only consequence of "breaking" here is that a human looks.
 */
export function isBreakingBump(bump: DependencyBump): boolean {
  const from = numericParts(bump.from);
  const to = numericParts(bump.to);
  if (from === undefined || to === undefined) return true;
  const [fromMajor, fromMinor] = from;
  const [toMajor, toMinor] = to;
  if (fromMajor !== toMajor) return true;
  return fromMajor === 0 && fromMinor !== toMinor;
}

/**
 * The body the shepherd writes onto a Dependabot PR, or `undefined` when no bump could be
 * read (the PR is then left exactly as Dependabot wrote it). Deterministic, and a fixed point:
 * `summaryBody(t, summaryBody(t, b))` equals `summaryBody(t, b)`.
 *
 * The text contains no parentheses at all. Dependency names cannot contain them and versions
 * do not, so the list itself is safe; the prose is written to need none.
 */
export function summaryBody(title: string, body: string): string | undefined {
  const bumps = parseBumps(title, body);
  if (bumps.length === 0) return undefined;
  const noun = bumps.length === 1 ? "dependency" : "dependencies";
  return [
    SUMMARY_MARKER,
    `Bumps ${String(bumps.length)} ${noun}:`,
    "",
    ...bumps.map((b) => `- \`${b.name}\` ${b.from} -> ${b.to}`),
    "",
    "Summarised by the Dependabot shepherd from Dependabot's description, which quotes upstream",
    "release notes verbatim. This body becomes the squash commit, and quoted notes with an",
    "unbalanced parenthesis make release-please drop the commit from the changelog. The original",
    "description, release notes included, is in this PR's edit history.",
  ].join("\n");
}
