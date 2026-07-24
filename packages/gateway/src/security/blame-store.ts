import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface BlameRow {
  readonly lineNo: number;
  readonly commitSha: string;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authorTimeMs: number | null;
}

interface CommitMeta {
  name: string | null;
  email: string | null;
  timeMs: number | null;
}

/**
 * Parse `git blame --line-porcelain` (or `--porcelain`) into one row per blamed
 * line. `--line-porcelain` repeats the commit's author block on every line;
 * `--porcelain` emits it only on the first line of each commit, so we cache
 * commit metadata by SHA and carry it forward for abbreviated blocks.
 */
export function parseBlamePorcelain(out: string): BlameRow[] {
  const rows: BlameRow[] = [];
  const lines = out.split(/\r?\n/);
  const metaBySha = new Map<string, CommitMeta>();
  let cur: { sha: string; lineNo: number } | null = null;
  let meta: CommitMeta | null = null;
  const headerRe = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;
  for (const ln of lines) {
    const h = headerRe.exec(ln);
    if (h !== null) {
      const sha = h[1] ?? "";
      cur = { sha, lineNo: Number.parseInt(h[2] ?? "0", 10) };
      meta = metaBySha.get(sha) ?? { name: null, email: null, timeMs: null };
      metaBySha.set(sha, meta);
      continue;
    }
    if (cur === null || meta === null) continue;
    if (ln.startsWith("author ")) {
      meta.name = ln.slice("author ".length);
    } else if (ln.startsWith("author-mail ")) {
      meta.email = ln.slice("author-mail ".length).replace(/^<|>$/g, "");
    } else if (ln.startsWith("author-time ")) {
      const t = Number.parseInt(ln.slice("author-time ".length), 10);
      meta.timeMs = Number.isFinite(t) ? t * 1000 : null;
    } else if (ln.startsWith("\t")) {
      // the content line terminates this porcelain block
      rows.push({
        lineNo: cur.lineNo,
        commitSha: cur.sha,
        authorName: meta.name,
        authorEmail: meta.email,
        authorTimeMs: meta.timeMs,
      });
      cur = null;
    }
  }
  return rows;
}

export function upsertBlameLines(
  db: Database,
  repoRoot: string,
  filePath: string,
  rows: readonly BlameRow[],
): void {
  for (const r of rows) {
    dbRun(
      db,
      `INSERT INTO git_blame_line (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_root, file_path, line_no) DO UPDATE SET
         commit_sha = excluded.commit_sha,
         author_name = excluded.author_name,
         author_email = excluded.author_email,
         author_time_ms = excluded.author_time_ms`,
      [repoRoot, filePath, r.lineNo, r.commitSha, r.authorName, r.authorEmail, r.authorTimeMs],
    );
  }
}

/** Deletes all blame rows for one `(repo_root, file_path)` — the incremental
 * indexer's idempotent per-file re-blame + stale/deleted-file cleanup. */
export function pruneBlameForFile(db: Database, repoRoot: string, filePath: string): void {
  dbRun(db, `DELETE FROM git_blame_line WHERE repo_root = ? AND file_path = ?`, [
    repoRoot,
    filePath,
  ]);
}

export interface BlameLookup {
  readonly commitSha: string;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authorTimeMs: number | null;
}

export function lookupBlame(
  db: Database,
  repoRoot: string,
  filePath: string,
  lineNo: number,
): BlameLookup | null {
  const row = db
    .query(
      `SELECT commit_sha, author_name, author_email, author_time_ms
         FROM git_blame_line WHERE repo_root = ? AND file_path = ? AND line_no = ?`,
    )
    .get(repoRoot, filePath, lineNo) as
    | {
        commit_sha: string;
        author_name: string | null;
        author_email: string | null;
        author_time_ms: number | null;
      }
    | undefined
    | null;
  if (row === undefined || row === null) return null;
  return {
    commitSha: row.commit_sha,
    authorName: row.author_name,
    authorEmail: row.author_email,
    authorTimeMs: row.author_time_ms,
  };
}
