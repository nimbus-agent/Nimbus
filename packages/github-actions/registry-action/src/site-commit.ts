/**
 * Writing the signed site to `gh-pages` (design § 7.3, § 7.4). The commit is built with git
 * plumbing over a private index file — never a checkout — so the bytes committed are exactly the
 * bytes given (no line-ending or other filter can touch a `package.tgz` or the signed
 * `index.json`), and the registry checkout's own working tree and index are never modified.
 *
 * The push uses whatever credentials the checkout persisted (`actions/checkout` stores the job's
 * `GITHUB_TOKEN` in the repository's git config); nothing here reads or passes a token. It is a
 * plain, non-forced push, so a concurrent writer makes it fail as non-fast-forward, which the
 * caller answers by starting over from a fresh fetch.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeTreePath } from "./git-tree.ts";

/** The identity the sign job commits as. */
const BOT_IDENTITY = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
] as const;

export interface SiteFile {
  path: string;
  bytes: Uint8Array;
}

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
}

function run(args: readonly string[], opts: RunOptions): string {
  return execFileSync("git", [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString("utf8")
    .trim();
}

/**
 * A commit on top of `parent` whose tree is `parent`'s with `files` written over it, or `undefined`
 * when that tree equals `parent`'s (nothing to publish, so no commit).
 */
export function commitSite(
  parent: string,
  files: readonly SiteFile[],
  message: string,
  cwd: string,
): string | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "nimbus-registry-site-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    run(["read-tree", parent], { cwd, env });
    for (const f of files) {
      assertSafeTreePath(f.path);
      const blob = run(["hash-object", "-w", "--no-filters", "--stdin"], { cwd, input: f.bytes });
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`], { cwd, env });
    }
    const tree = run(["write-tree"], { cwd, env });
    if (tree === run(["rev-parse", `${parent}^{tree}`], { cwd })) return undefined;
    return run([...BOT_IDENTITY, "commit-tree", tree, "-p", parent, "-m", message], { cwd });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** git's words for a push the remote refused because the branch moved underneath it. */
const NON_FAST_FORWARD = /non-fast-forward|fetch first|\[rejected\]/;

export type PushResult = "pushed" | "non-fast-forward";

/** Push `commit` to `origin`'s `branch`, never forced. Any failure but a non-fast-forward throws. */
export function pushCommit(commit: string, branch: string, cwd: string): PushResult {
  try {
    run(["push", "--porcelain", "origin", `${commit}:refs/heads/${branch}`], { cwd });
    return "pushed";
  } catch (err) {
    const text = [
      err !== null && typeof err === "object" && "stderr" in err ? String(err.stderr) : "",
      err !== null && typeof err === "object" && "stdout" in err ? String(err.stdout) : "",
    ].join("\n");
    if (NON_FAST_FORWARD.test(text)) return "non-fast-forward";
    throw new Error(`git push to ${branch} failed: ${text.trim()}`);
  }
}
