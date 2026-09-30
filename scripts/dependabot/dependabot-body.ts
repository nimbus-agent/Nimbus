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
// Both this and the `Bumps` line tolerate the note Dependabot appends to a bump that closes an
// advisory (`**This update includes a security fix.**`). Its message builder puts that on the
// single-package `Bumps` line; it is accepted here too, so a bump is never dropped for it.
const UPDATES_LINE =
  /^Updates `([^`]+)` from (\S+) to (\S+?)\.?(?: \*\*This update includes (?:a security fix|security fixes)\.\*\*)?$/;
// single-package npm/cargo:   Bumps [name](url) from 1.0.0 to 1.1.0.
const BUMPS_LINE =
  /^Bumps \[([^\]]+)\]\([^)]*\) from (\S+) to (\S+?)\.?(?: \*\*This update includes (?:a security fix|security fixes)\.\*\*)?$/;
// A line announcing a change to one dependency. One that starts like this and matches no
// pattern above is a change this module could not read: `Removes`, or an `Updates` line
// with no `from` version.
const ANNOUNCES_CHANGE = /^(?:Updates|Removes) `/;
// The three places a count of the bumps is stated, in order of trust:
// group intro in the body:    Bumps the all-minor-patch group with 17 updates …
const INTRO_COUNT = /^Bumps the .+ group with (\d+) updates?\b/;
// our own summary header:     Bumps 17 dependencies:
const SUMMARY_COUNT = /^Bumps (\d+) dependenc(?:y|ies):$/;
// group title:                … group across 1 directory with 17 updates
const TITLE_COUNT = /\bwith (\d+) updates?\b/i;

/**
 * How many bumps the PR itself says it carries, or `undefined` when it does not say.
 *
 * The body's own statement outranks the title's: on #902 the title announced 27 updates while
 * the description announced, and listed, 25 — so Dependabot's title is not a reliable count of
 * its own description, and is consulted only when the description states none.
 */
function announcedCount(
  title: string,
  lines: readonly string[],
  summarised: boolean,
): number | undefined {
  const inBody = lines
    .map((l) => (summarised ? SUMMARY_COUNT : INTRO_COUNT).exec(l.trim())?.[1])
    .filter((n) => n !== undefined);
  if (inBody.length > 0) return inBody.reduce((sum, n) => sum + Number(n), 0);
  if (summarised) return undefined;
  const inTitle = TITLE_COUNT.exec(title)?.[1];
  return inTitle === undefined ? undefined : Number(inTitle);
}
// our own summary lines:      - `name` 1.0.0 -> 1.1.0
const SUMMARY_LINE = /^- `([^`]+)` (\S+) -> (\S+)$/;
// title fallback:             chore(deps): bump name from 1.0.0 to 1.1.0 [in /dir]
const TITLE = /\bbump (\S+) from (\S+) to (\S+?)(?: in \S+)?$/i;

interface BumpScan {
  readonly bumps: DependencyBump[];
  /** Why `bumps` cannot be trusted to be the WHOLE list; `undefined` when it can. */
  readonly incomplete: string | undefined;
}

function matchBump(line: string, patterns: readonly RegExp[]): DependencyBump | undefined {
  for (const pattern of patterns) {
    const m = pattern.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      return { name: m[1], from: m[2], to: m[3] };
    }
  }
  return undefined;
}

function scanBumps(title: string, body: string): BumpScan {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const summarised = lines[0]?.trim() === SUMMARY_MARKER;
  const patterns = summarised ? [SUMMARY_LINE] : [TABLE_ROW, UPDATES_LINE, BUMPS_LINE];
  const seen = new Map<string, DependencyBump>();
  let incomplete: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    const bump = matchBump(line, patterns);
    if (bump === undefined) {
      if (!summarised && ANNOUNCES_CHANGE.test(line)) incomplete ??= `unreadable line "${line}"`;
      continue;
    }
    const first = seen.get(bump.name);
    if (first === undefined) seen.set(bump.name, bump);
    else if (first.from !== bump.from || first.to !== bump.to) {
      incomplete ??= `"${bump.name}" is listed with two different version changes`;
    }
  }
  if (seen.size === 0) {
    const bump = matchBump(title.trim(), [TITLE]);
    if (bump !== undefined) seen.set(bump.name, bump);
  }
  const announced = announcedCount(title, lines, summarised);
  if (announced !== undefined && announced !== seen.size) {
    incomplete ??= `the PR announces ${String(announced)} updates and ${String(seen.size)} could be read`;
  }
  return { bumps: [...seen.values()], incomplete };
}

/**
 * Every bump the PR carries, de-duplicated by name, in first-seen order. Empty when nothing
 * recognisable is present — callers must treat that as "leave this PR alone", never as "no
 * changes". A NON-empty list is not yet a complete one: ask `incompleteBumpsReason` before
 * deciding anything that depends on having seen every bump.
 */
export function parseBumps(title: string, body: string): DependencyBump[] {
  return scanBumps(title, body).bumps;
}

/**
 * Why the list `parseBumps` returns may be missing a change, or `undefined` when it is whole.
 *
 * A partial list is worse than an empty one. "Every bump is non-breaking" is a claim about the
 * WHOLE group, so one unread line is enough for a 0.x minor to be auto-merged unseen — and once
 * the description has been replaced by a summary of the partial list, the missing bump is gone
 * from every later classification too. Three signs, each independent of the others:
 *
 *   - a line announces a change (`Updates` or `Removes`) and no pattern could read it;
 *   - one name appears with two different version changes, so the first would hide the second;
 *   - the PR's own count (`with N updates`) disagrees with the number read.
 */
export function incompleteBumpsReason(title: string, body: string): string | undefined {
  return scanBumps(title, body).incomplete;
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
 * read or the list may be partial (the PR is then left exactly as Dependabot wrote it, since a
 * summary of a partial list would erase the bump it missed). Deterministic, and a fixed point:
 * `summaryBody(t, summaryBody(t, b))` equals `summaryBody(t, b)`.
 *
 * The text contains no parentheses at all. Dependency names cannot contain them and versions
 * do not, so the list itself is safe; the prose is written to need none.
 */
export function summaryBody(title: string, body: string): string | undefined {
  const { bumps, incomplete } = scanBumps(title, body);
  if (bumps.length === 0 || incomplete !== undefined) return undefined;
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
