import type { Database } from "bun:sqlite";

import { dbRun, dbStmtRun } from "../db/write.ts";

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed";

export type ChangedFileRow = {
  readonly path: string;
  readonly status: ChangedFileStatus;
  /** A rename's other half, for display. No predicate reads this. */
  readonly counterpartPath: string | null;
};

export type NegationResult = {
  readonly itemIds: readonly string[];
  readonly excludedNoCoverage: number;
  readonly excludedTruncated: number;
};

/**
 * Replace a PR's entire changed-file set and stamp its coverage row, in ONE transaction.
 *
 * The transaction boundary is correctness, not speed: the coverage row asserts "we know this PR's
 * files", so it must land with the rows it describes. A crash between them would leave a PR marked
 * covered with a partial list — a confident wrong answer, which is the exact failure the coverage
 * table exists to prevent.
 *
 * DELETE-then-insert rather than upsert: a re-fetch is a fresh truth. A file dropped from a PR
 * between fetches must disappear, and merging would leave it behind forever.
 */
export function recordPrChangedFiles(
  db: Database,
  args: {
    readonly itemId: string;
    readonly repoFull: string;
    readonly files: readonly ChangedFileRow[];
    readonly apiFileCount: number;
    readonly truncated: boolean;
    readonly nowMs: number;
  },
): void {
  // `db.transaction(fn)` RETURNS a function; the trailing `()` runs it. Omitting that call is a
  // silent no-op — nothing is written and nothing throws. House style is to invoke it inline
  // (`connectors/obsidian-sync.ts:243-256`).
  db.transaction(() => {
    dbRun(db, "DELETE FROM pr_changed_file WHERE item_id = ?", [args.itemId]);
    const stmt = db.prepare(
      `INSERT INTO pr_changed_file (item_id, repo_full, path, status, counterpart_path)
       VALUES (?, ?, ?, ?, ?)`,
    );
    try {
      for (const f of args.files) {
        // NOTE the calling convention difference, verified against real call sites:
        // `dbStmtRun` takes its params SPREAD (`dbStmtRun(stmt, a, b, c)` — see
        // `embedding/pipeline.ts:157`), while `dbRun` below takes them as an ARRAY.
        // Passing an array here binds ONE argument, not five, and fails at runtime.
        dbStmtRun(stmt, args.itemId, args.repoFull, f.path, f.status, f.counterpartPath);
      }
    } finally {
      // An unfinalized prepare() makes close() a silent no-op on this database.
      stmt.finalize();
    }
    dbRun(
      db,
      `INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count, truncated)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (item_id) DO UPDATE SET
         fetched_at_ms = excluded.fetched_at_ms,
         api_file_count = excluded.api_file_count,
         stored_count = excluded.stored_count,
         truncated = excluded.truncated`,
      [args.itemId, args.nowMs, args.apiFileCount, args.files.length, args.truncated ? 1 : 0],
    );
  })();
}

/**
 * The canonical fail-closed negation query. W6-B calls this rather than rebuilding it.
 *
 * The INNER JOIN to `pr_files_state` is the mechanism, not an optimisation: a PR with no coverage
 * row cannot appear in the result at all. A LEFT JOIN here — or reading `pr_changed_file` alone —
 * silently returns every unfetched PR as a confident "does not touch X".
 *
 * GLOB, never LIKE: LIKE is case-insensitive for ASCII and treats `_` as a wildcard, both verified
 * against this repo's bun:sqlite. Paths are case-sensitive on Linux and macOS, and `_` is common in
 * real filenames, so LIKE would answer a `tests/` question with `Tests/` data and turn any pattern
 * containing an underscore into a wildcard.
 */
export function selectPrsNotTouching(
  db: Database,
  args: { readonly pathGlob: string; readonly limit: number },
): NegationResult {
  const rows = db
    .query(
      `SELECT i.id AS id
         FROM item i
         JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr'
          AND s.truncated = 0
          AND NOT EXISTS (
                SELECT 1 FROM pr_changed_file f
                 WHERE f.item_id = i.id AND f.path GLOB ?1
              )
        ORDER BY i.id
        LIMIT ?2`,
    )
    .all(args.pathGlob, args.limit) as Array<{ id: string }>;

  const noCov = db
    .query(
      `SELECT COUNT(*) AS c FROM item i
        LEFT JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.item_id IS NULL`,
    )
    .get() as { c: number } | null;

  const trunc = db
    .query(
      `SELECT COUNT(*) AS c FROM item i
         JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.truncated = 1`,
    )
    .get() as { c: number } | null;

  return {
    itemIds: rows.map((r) => r.id),
    excludedNoCoverage: noCov?.c ?? 0,
    excludedTruncated: trunc?.c ?? 0,
  };
}

/** Coverage summary for `diag.snapshot`. `covered` includes truncated PRs — they were fetched. */
export function collectPrFileCoverage(db: Database): {
  readonly covered: number;
  readonly totalPrs: number;
  readonly truncated: number;
} {
  const row = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM pr_files_state) AS covered,
         (SELECT COUNT(*) FROM item WHERE type = 'pr') AS total_prs,
         (SELECT COUNT(*) FROM pr_files_state WHERE truncated = 1) AS truncated`,
    )
    .get() as { covered: number; total_prs: number; truncated: number } | null;
  return {
    covered: row?.covered ?? 0,
    totalPrs: row?.total_prs ?? 0,
    truncated: row?.truncated ?? 0,
  };
}
