import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { type BlameRow, parseBlamePorcelain } from "../security/blame-store.ts";

type SpawnFn = typeof Bun.spawn;
const GIT_TIMEOUT_MS = 30_000;

/** A single file's change relative to a prior HEAD, as parsed from
 * `git diff --name-status -M`. A rename is expanded by the caller to a
 * `D` (old path) + `A` (new path, carrying `oldPath`). */
export interface BlameChange {
  readonly path: string;
  readonly status: "A" | "M" | "D";
  readonly oldPath?: string;
}

async function runGit(
  root: string,
  args: readonly string[],
  spawn: SpawnFn,
): Promise<{ code: number; out: string }> {
  try {
    const proc = spawn(["git", "-C", root, ...args], {
      env: extensionProcessEnv({}),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { code, out };
  } catch {
    // AbortError (timeout), ENOENT (git not on PATH), or spawn failure → treated
    // as a non-fatal empty result so the indexer degrades to zero blame.
    return { code: 1, out: "" };
  }
}

/** `git rev-parse HEAD`; null if not a resolvable 40-hex sha (empty repo, not a repo). */
export async function gitHeadSha(root: string, spawn: SpawnFn = Bun.spawn): Promise<string | null> {
  const { code, out } = await runGit(root, ["rev-parse", "HEAD"], spawn);
  const sha = out.trim();
  return code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** True iff `sha` is an ancestor of HEAD (`git merge-base --is-ancestor`). A
 * false result means history was rewritten (or the sha is unknown) → the caller
 * should fall back to a full re-blame rather than an incremental diff. */
export async function isAncestor(
  root: string,
  sha: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<boolean> {
  const { code } = await runGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"], spawn);
  return code === 0;
}

/** Tracked files with at least one commit in the last `windowDays`, repo-relative
 * and deduped. NUL-separated to survive any path characters. */
export async function gitBlameWindowFiles(
  root: string,
  windowDays: number,
  spawn: SpawnFn = Bun.spawn,
): Promise<string[]> {
  const { code, out } = await runGit(
    root,
    ["log", `--since=${String(windowDays)} days ago`, "--name-only", "--pretty=format:", "-z"],
    spawn,
  );
  if (code !== 0) return [];
  const seen = new Set<string>();
  for (const p of out.split("\0")) {
    const f = p.trim();
    if (f !== "") seen.add(f);
  }
  return [...seen];
}

/** Parsed `git diff --name-status -M <sinceSha> HEAD`. Renames (`R###`) expand
 * to a `D` of the old path plus an `A` of the new path (carrying `oldPath`). */
export async function gitChangedSince(
  root: string,
  sinceSha: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<BlameChange[]> {
  const { code, out } = await runGit(
    root,
    ["diff", "--name-status", "-M", "-z", sinceSha, "HEAD"],
    spawn,
  );
  if (code !== 0) return [];
  const toks = out.split("\0").filter((s) => s !== "");
  const changes: BlameChange[] = [];
  for (let i = 0; i < toks.length; ) {
    const st = toks[i] ?? "";
    if (st.startsWith("R")) {
      // rename: <status>\0<oldPath>\0<newPath>
      changes.push({ status: "D", path: toks[i + 1] ?? "" });
      changes.push({ status: "A", path: toks[i + 2] ?? "", oldPath: toks[i + 1] ?? "" });
      i += 3;
    } else {
      const s = st.charAt(0);
      const status = s === "A" ? "A" : s === "D" ? "D" : "M";
      changes.push({ status, path: toks[i + 1] ?? "" });
      i += 2;
    }
  }
  return changes;
}

/** Whole-file `git blame --line-porcelain`; empty on any non-zero exit. */
export async function gitBlameWholeFile(
  root: string,
  relFile: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<BlameRow[]> {
  const { code, out } = await runGit(root, ["blame", "--line-porcelain", "--", relFile], spawn);
  if (code !== 0) return [];
  return parseBlamePorcelain(out);
}
