import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Checks this repo's OWN commit permalinks offline: every
 * `https://github.com/nimbus-agent/Nimbus/commit/<sha>` in the markdown lychee scans must name a
 * commit that exists in the local repository.
 *
 * lychee excludes these links (`lychee.toml`) because github.com answers commit pages with
 * intermittent 503s — the same URL 503s and then 200s within seconds, from a dev machine as well
 * as runner egress, so neither the API token nor `check-links.sh`'s second pass makes them
 * reliable, and `CHANGELOG.md` gains more of them with every release. The question a link check
 * asks of such a link — does this commit exist? — has a deterministic local answer, so it is
 * answered here instead.
 *
 * Fails CLOSED on a shallow clone: there, a missing object proves nothing, and passing would make
 * this a gate that cannot fail. CI checks out with `fetch-depth: 0` for that reason.
 */

const COMMIT_LINK = /https:\/\/github\.com\/nimbus-agent\/Nimbus\/commit\/([0-9a-fA-F]{7,40})\b/g;

/** The same inputs `scripts/check-links.sh` hands lychee, minus lychee's `exclude_path` dirs. */
const GLOBS = ["docs/**/*.md", "*.md"] as const;
const EXCLUDED_PREFIXES = [".claude/", "node_modules/", ".git/"] as const;

export interface CommitLink {
  readonly file: string;
  readonly line: number;
  readonly sha: string;
}

export function extractCommitLinks(file: string, content: string): CommitLink[] {
  const out: CommitLink[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of (lines[i] ?? "").matchAll(COMMIT_LINK)) {
      const sha = m[1];
      if (sha !== undefined) out.push({ file, line: i + 1, sha: sha.toLowerCase() });
    }
  }
  return out;
}

/** The links whose sha `exists` rejects, each unique sha asked about once. */
export function findMissing(
  links: readonly CommitLink[],
  exists: (shas: readonly string[]) => ReadonlySet<string>,
): CommitLink[] {
  const unique = [...new Set(links.map((l) => l.sha))];
  const present = exists(unique);
  return links.filter((l) => !present.has(l.sha));
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
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.error(
      "audit:commit-links: this is a shallow clone, so a missing commit proves nothing. " +
        "Fetch full history (`git fetch --unshallow`, or `fetch-depth: 0` in CI).",
    );
    process.exit(1);
  }
  const files = new Set<string>();
  for (const pattern of GLOBS) {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: process.cwd(), dot: false })) {
      const rel = f.replaceAll("\\", "/");
      if (!EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) files.add(rel);
    }
  }
  const links = [...files].sort().flatMap((f) => extractCommitLinks(f, readFileSync(f, "utf8")));
  const missing = findMissing(links, existingCommits);
  for (const m of missing) {
    console.error(`${m.file}:${String(m.line)}: commit ${m.sha} does not exist in this repository`);
  }
  if (missing.length > 0) {
    console.error(`audit:commit-links: FAILED (${String(missing.length)} broken commit link(s))`);
    process.exit(1);
  }
  console.log(
    `audit:commit-links: ${String(links.length)} commit link(s) across ${String(files.size)} file(s) OK`,
  );
}

if (import.meta.main) {
  main();
}
