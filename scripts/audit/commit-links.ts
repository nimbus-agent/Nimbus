import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Checks this repo's OWN commit permalinks offline: every link under
 * `https://github.com/nimbus-agent/Nimbus/commit/` in the markdown lychee scans must name, as a 7-40
 * hex sha, a commit that exists in the local repository.
 *
 * lychee excludes exactly that URL prefix (`lychee.toml`, anchored with `^`) because github.com
 * answers commit pages with intermittent 503s — the same URL 503s and then 200s within seconds,
 * from a dev machine as well as runner egress, so neither the API token nor `check-links.sh`'s
 * second pass makes them reliable, and `CHANGELOG.md` gains more of them with every release. The
 * question a link check asks of such a link — does this commit exist? — has a deterministic local
 * answer, so it is answered here instead. Every link lychee skips is therefore checked here: one
 * whose path is not a sha this audit can resolve is an error, never ignored.
 *
 * On a shallow clone a missing object proves nothing. CI (which checks out with `fetch-depth: 0`)
 * fails closed there; a local run skips with a warning instead, so a developer on a shallow clone
 * can still push through the `preflight:fast` pre-push hook. CI is the authoritative run.
 */

const COMMIT_LINK = /https:\/\/github\.com\/nimbus-agent\/Nimbus\/commit\/([^\s)\]>"'`#?]*)/g;
const SHA = /^[0-9a-f]{7,40}$/;

/** The same inputs `scripts/check-links.sh` hands lychee, minus lychee's `exclude_path` dirs. */
const GLOBS = ["docs/**/*.md", "*.md"] as const;
const EXCLUDED_PREFIXES = [".claude/", "node_modules/", ".git/"] as const;

export interface CommitLink {
  readonly file: string;
  readonly line: number;
  /** The path segment after `/commit/`, as written. */
  readonly ref: string;
  /** `ref` lower-cased when it is a 7-40 hex sha; `null` when it is not one. */
  readonly sha: string | null;
}

export function extractCommitLinks(file: string, content: string): CommitLink[] {
  const out: CommitLink[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of (lines[i] ?? "").matchAll(COMMIT_LINK)) {
      // GFM drops trailing punctuation from a bare autolink, so a URL ending a sentence does too.
      const ref = (m[1] ?? "").replace(/[.,:;!*_~]+$/, "");
      const lower = ref.toLowerCase();
      out.push({ file, line: i + 1, ref, sha: SHA.test(lower) ? lower : null });
    }
  }
  return out;
}

export interface CommitLinkProblem {
  readonly link: CommitLink;
  readonly reason: "not_a_sha" | "missing";
}

/** Every link that is not a resolvable sha, or whose sha `exists` rejects; each sha asked once. */
export function findProblems(
  links: readonly CommitLink[],
  exists: (shas: readonly string[]) => ReadonlySet<string>,
): CommitLinkProblem[] {
  const unique = [...new Set(links.flatMap((l) => (l.sha === null ? [] : [l.sha])))];
  const present = exists(unique);
  const problems: CommitLinkProblem[] = [];
  for (const link of links) {
    if (link.sha === null) problems.push({ link, reason: "not_a_sha" });
    else if (!present.has(link.sha)) problems.push({ link, reason: "missing" });
  }
  return problems;
}

/** What a run does about a shallow clone: CI fails closed, a local run skips. */
export function shallowVerdict(
  isShallow: boolean,
  ci: string | undefined,
): "run" | "skip" | "fail" {
  if (!isShallow) return "run";
  return ci === "true" ? "fail" : "skip";
}

function git(args: readonly string[], input?: string): string {
  const r = spawnSync("git", args, { encoding: "utf8", input, windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/** One `git cat-file --batch-check` over every sha; a sha is present only if it names a commit. */
function existingCommits(shas: readonly string[]): ReadonlySet<string> {
  if (shas.length === 0) return new Set();
  const out = git(["cat-file", "--batch-check"], shas.map((s) => `${s}^{commit}`).join("\n"));
  const present = new Set<string>();
  const rows = out.trimEnd().split("\n");
  for (let i = 0; i < shas.length; i += 1) {
    const sha = shas[i];
    const row = rows[i] ?? "";
    if (sha !== undefined && / commit \d+$/.test(row)) present.add(sha);
  }
  return present;
}

function main(): void {
  const isShallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const verdict = shallowVerdict(isShallow, process.env["CI"]);
  if (verdict !== "run") {
    const msg =
      "audit:commit-links: this is a shallow clone, so a missing commit proves nothing. " +
      "Fetch full history (`git fetch --unshallow`, or `fetch-depth: 0` in CI).";
    if (verdict === "fail") {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`${msg} SKIPPED locally; CI runs it with full history.`);
    return;
  }
  const files = new Set<string>();
  for (const pattern of GLOBS) {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: process.cwd(), dot: false })) {
      const rel = f.replaceAll("\\", "/");
      if (!EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) files.add(rel);
    }
  }
  const links = [...files].sort().flatMap((f) => extractCommitLinks(f, readFileSync(f, "utf8")));
  const problems = findProblems(links, existingCommits);
  for (const { link, reason } of problems) {
    const where = `${link.file}:${String(link.line)}`;
    console.error(
      reason === "missing"
        ? `${where}: commit ${link.ref} does not exist in this repository`
        : `${where}: commit link ${JSON.stringify(link.ref)} is not a 7-40 character hex sha`,
    );
  }
  if (problems.length > 0) {
    console.error(`audit:commit-links: FAILED (${String(problems.length)} broken commit link(s))`);
    process.exit(1);
  }
  console.log(
    `audit:commit-links: ${String(links.length)} commit link(s) across ${String(files.size)} file(s) OK`,
  );
}

if (import.meta.main) {
  main();
}
