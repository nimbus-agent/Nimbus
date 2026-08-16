#!/usr/bin/env bun

/**
 * Guard — a pending release PR must account for EVERY user-facing commit since the last tag.
 *
 * The existing drop-guard in `.github/workflows/release-please.yml` asks "did release-please
 * produce a release, or a release PR?" and passes the moment one exists. That is existence, not
 * completeness, and the gap is not theoretical:
 *
 *   v2.4.6 (2026-08-16). release-please failed to parse the squash commit for #1218
 *   (`fix(security): widen D12 …`) — `Error: unexpected token '(' at 103:15` — because the PR
 *   body, which becomes the squash commit body, contained `` `.run(` ``/`` `.exec(` ``: code spans
 *   holding unbalanced parentheses. The runs on #1218 and #1219 went red on the drop-guard, exactly
 *   as designed. Then #1220 merged, release-please opened a release PR covering #1220 and #1221,
 *   `prs_created` came back true, and the guard went green — with #1218 still missing from the
 *   changelog. A security fix shipped in v2.4.6 with no entry in its release notes.
 *
 * So this asks the other question: of the feat/fix commits since the newest tag, which ones does
 * the pending release PR's CHANGELOG diff NOT mention? Anything it cannot find is reported and the
 * run fails, because the remedy needs a human — the release PR's changelog has to be edited before
 * it is merged, and once merged the tag is immutable (see CLAUDE.md).
 *
 * Deliberately narrow. It only runs when a release PR is actually pending; the "nothing was
 * produced at all" case stays with the existing guard, which already handles it and says more.
 */

/** A commit release-please is expected to put in the changelog. */
export interface UserFacingCommit {
  /** The commit subject line, verbatim. */
  readonly subject: string;
  /** The `#NNNN` reference a squash merge appends, when present. */
  readonly pr?: string;
}

/**
 * `feat:` / `fix:` with an optional scope and an optional `!`.
 *
 * SUBJECTS ONLY — the caller must pass first lines. A body line can look like a conventional
 * header (this very file contains several inside a doc comment), and counting those would make the
 * guard fire on healthy runs, which is how a guard gets deleted.
 */
const USER_FACING_RE = /^(?:feat|fix)(?:\([^)]*\))?!?:/;
/** The trailing `(#1234)` a squash merge appends to the subject. */
const PR_REF_RE = /\(#(\d+)\)\s*$/;

export function userFacingSubjects(subjects: readonly string[]): UserFacingCommit[] {
  const out: UserFacingCommit[] = [];
  for (const raw of subjects) {
    // trimEnd only. Leading whitespace is the tell that this is a BODY line rather than a subject
    // — conventional headers are column-anchored — and trimming it would let an indented example
    // inside a commit body be counted as a commit, which is precisely how this guard would start
    // firing on healthy runs.
    const subject = raw.trimEnd();
    if (!USER_FACING_RE.test(subject)) continue;
    const pr = PR_REF_RE.exec(subject)?.[1];
    out.push(pr === undefined ? { subject } : { subject, pr });
  }
  return out;
}

/** The human-readable part of a conventional subject, minus type, scope and PR ref. */
export function descriptionOf(subject: string): string {
  return subject
    .replace(/^(?:feat|fix)(?:\([^)]*\))?!?:\s*/, "")
    .replace(PR_REF_RE, "")
    .trim();
}

/**
 * Which user-facing commits the changelog does not mention.
 *
 * Matched on the PR number first — release-please writes `([#1221](…/issues/1221))`, and a number
 * is exact where prose is not. A commit with no PR reference (a direct push to main) falls back to
 * its description text, which is what release-please would have written verbatim.
 */
export function droppedFromChangelog(
  commits: readonly UserFacingCommit[],
  changelogAdded: string,
): UserFacingCommit[] {
  return commits.filter((c) => {
    if (c.pr !== undefined) return !new RegExp(`#${c.pr}\\b`).test(changelogAdded);
    const description = descriptionOf(c.subject);
    return description !== "" && !changelogAdded.includes(description);
  });
}

/** Added lines of every CHANGELOG patch in a PR's file list — what the release PR would land. */
export function addedChangelogLines(
  files: readonly { readonly filename: string; readonly patch?: string }[],
): string {
  return files
    .filter((f) => /(^|\/)CHANGELOG\.md$/.test(f.filename))
    .map((f) => f.patch ?? "")
    .join("\n")
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .join("\n");
}

export interface CompletenessInput {
  /** Commit SUBJECTS (first lines) since the newest release tag. */
  readonly subjects: readonly string[];
  /** The pending release PR's CHANGELOG file patches, or undefined when no release PR is open. */
  readonly releasePrFiles?: readonly { readonly filename: string; readonly patch?: string }[];
  /** The tag the comparison was baselined on, for the message. */
  readonly tag: string;
}

export interface CompletenessResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly checked: number;
}

export function checkCompleteness(input: CompletenessInput): CompletenessResult {
  const commits = userFacingSubjects(input.subjects);
  // No release PR open: the existing drop-guard owns that case and reports it better.
  if (input.releasePrFiles === undefined) return { ok: true, errors: [], checked: commits.length };
  if (commits.length === 0) return { ok: true, errors: [], checked: 0 };

  const added = addedChangelogLines(input.releasePrFiles);
  if (added.trim() === "") {
    return {
      ok: false,
      checked: commits.length,
      errors: [
        `the pending release PR adds no CHANGELOG lines, but there ${commits.length === 1 ? "is" : "are"} ${commits.length} user-facing commit(s) since ${input.tag}`,
      ],
    };
  }

  const dropped = droppedFromChangelog(commits, added);
  if (dropped.length === 0) return { ok: true, errors: [], checked: commits.length };

  return {
    ok: false,
    checked: commits.length,
    errors: [
      `the pending release PR omits ${dropped.length} of ${commits.length} user-facing commit(s) since ${input.tag}:`,
      ...dropped.map((c) => `  dropped: ${c.subject}`),
      'release-please most likely could not PARSE one of these — open the release-please step of the run that FOLLOWED that merge and look for "error message: Error: unexpected token". An unbalanced `(` in a PR body does it, because the squash body IS the commit message.',
      "Fix by editing the release PR's CHANGELOG.md to add the missing entries BEFORE merging it. Do not add a Release-As: trailer, and do not merge and re-tag — tags are immutable (see CLAUDE.md).",
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function gh(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${err.trim() || out.trim()}`);
  return out;
}

async function main(): Promise<void> {
  const repo = process.env["REPO"];
  if (repo === undefined || repo === "") throw new Error("REPO is required");

  const refs = await gh([
    "api",
    `repos/${repo}/git/matching-refs/tags/v`,
    "--paginate",
    "--jq",
    ".[].ref",
  ]);
  const tag = refs
    .split("\n")
    .map((r) => r.replace(/^refs\/tags\//, "").trim())
    .filter((r) => /^v\d+\.\d+\.\d+$/.test(r))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
  if (tag === undefined) {
    console.log("release-pr-completeness: no release tag yet — nothing to compare against.");
    return;
  }

  const subjects = (
    await gh([
      "api",
      `repos/${repo}/compare/${tag}...main`,
      "--jq",
      '.commits[].commit.message | split("\\n")[0]',
    ])
  )
    .split("\n")
    .filter((s) => s.trim() !== "");

  const prNumbers = (
    await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      "autorelease: pending",
      "--json",
      "number",
      "--jq",
      ".[].number",
    ])
  )
    .split("\n")
    .filter((s) => s.trim() !== "");

  let releasePrFiles: { filename: string; patch?: string }[] | undefined;
  if (prNumbers.length > 0) {
    releasePrFiles = JSON.parse(
      await gh(["api", `repos/${repo}/pulls/${prNumbers[0]}/files`, "--paginate"]),
    ) as { filename: string; patch?: string }[];
  }

  const result = checkCompleteness({
    subjects,
    tag,
    ...(releasePrFiles === undefined ? {} : { releasePrFiles }),
  });
  if (!result.ok) {
    for (const e of result.errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(
    `release-pr-completeness: OK — ${result.checked} user-facing commit(s) since ${tag}${releasePrFiles === undefined ? " (no release PR open; the drop-guard owns that case)" : " all present in the pending release PR"}.`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      `::error::release-pr-completeness: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
