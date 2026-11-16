import type { Database } from "bun:sqlite";

import { type EpicTracker, JIRA_TRACKER } from "./epic-tracker.ts";

/**
 * Discover stage: closed epics the pass has not yet mined.
 *
 * Selects an EXPLICIT column list, never `SELECT *`. Bodies run to 16 KiB since
 * V48, and a pass that pulls a whole epic corpus into memory would degrade the
 * interactive gateway — the opposite of why this work was moved off the request
 * path.
 */

export type DiscoveredEpic = {
  itemId: string;
  /** The ticket key children reference via `metadata.parent_key` (e.g. `PROJ-1`). */
  epicKey: string;
  title: string;
  body: string;
  bodyComplete: boolean;
  /** Absent when the source never supplied one — never 0, which would read as 1970. */
  resolvedAtMs?: number;
  modifiedAt: number;
};

/** The trackers the pass mines. Linear joins in the feature commit that follows the refactor. */
const DISCOVER_TRACKERS: readonly EpicTracker[] = [JIRA_TRACKER];

type DiscoverRow = {
  id: string;
  external_id: string;
  title: string;
  body: string | null;
  body_complete: number;
  metadata: string;
  modified_at: number;
};

/** `(modified_at, id)` ascending, with `id` compared bytewise like SQLite's default collation. */
function byModifiedThenId(a: DiscoverRow, b: DiscoverRow): number {
  if (a.modified_at !== b.modified_at) {
    return a.modified_at - b.modified_at;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

// lane-census: scope=issue service=jira
function queryClosedEpics(
  db: Database,
  tracker: EpicTracker,
  opts: { watermarkMs: number; watermarkId: string; batchSize: number },
): DiscoverRow[] {
  return db
    .query(
      `SELECT id, external_id, title, body, body_complete, metadata, modified_at
         FROM item
        WHERE ${tracker.isEpicSql("item")}
          AND json_valid(metadata)
          AND json_extract(metadata, '$.status_category') IN ('done','canceled')
          AND (modified_at > ? OR (modified_at = ? AND id > ?))
        ORDER BY modified_at ASC, id ASC
        LIMIT ?`,
    )
    .all(opts.watermarkMs, opts.watermarkMs, opts.watermarkId, opts.batchSize) as DiscoverRow[];
}

/**
 * Resumes STRICTLY after `(watermarkMs, watermarkId)`. The composite tie-break
 * matters: a bulk import stamps thousands of rows with one `modified_at`, and
 * `modified_at > ?` alone would skip every row after the first in that group
 * while `>=` would re-scan them forever.
 *
 * One statement per tracker (each with its own `LIMIT batchSize` and the same resume predicate),
 * merged by `(modified_at, id)` and cut to `batchSize`: each arm's first `batchSize` rows after the
 * watermark contain the global first `batchSize`, so the merge is obviously correct.
 */
// lane-census: scope=issue service=jira
export function discoverClosedEpics(
  db: Database,
  opts: { watermarkMs: number; watermarkId: string; batchSize: number },
): DiscoveredEpic[] {
  const rows = DISCOVER_TRACKERS.flatMap((tracker) => queryClosedEpics(db, tracker, opts))
    .sort(byModifiedThenId)
    .slice(0, opts.batchSize);

  return rows.map((r) => {
    const meta = JSON.parse(r.metadata) as Record<string, unknown>;
    const resolved = meta["resolved_at_ms"];
    return {
      itemId: r.id,
      epicKey: r.external_id,
      title: r.title,
      body: r.body ?? "",
      bodyComplete: r.body_complete === 1,
      // Omit the key entirely when absent — never 0.
      ...(typeof resolved === "number" ? { resolvedAtMs: resolved } : {}),
      modifiedAt: r.modified_at,
    };
  });
}
