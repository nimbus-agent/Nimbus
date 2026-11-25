import type { Database } from "bun:sqlite";

import { EPIC_TRACKERS, type EpicTracker, LINEAR_TRACKER } from "./epic-tracker.ts";

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
  /** The epic's `external_id`: a Jira key children reference via `parent_key` (`PROJ-1`), or a Linear project UUID. */
  epicKey: string;
  title: string;
  body: string;
  bodyComplete: boolean;
  /** Absent when the source never supplied one — never 0, which would read as 1970. */
  resolvedAtMs?: number;
  modifiedAt: number;
};

/** The trackers the pass mines: every one with a descriptor. */
const DISCOVER_TRACKERS: readonly EpicTracker[] = EPIC_TRACKERS;

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

// lane-census: scope=issue,project service=jira,linear
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
// lane-census: scope=issue,project service=jira,linear
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

/**
 * An UPPER BOUND on the closed Linear projects the theme pass may not have mined: each was last
 * updated at or before the pass's single global watermark (so `--refresh`, which resumes from it,
 * never reaches it) and has no `premortem_theme_evidence` row. A project that WAS mined and yielded no
 * theme looks identical (the pass writes evidence only for an item an extracted theme cites, and the
 * watermark advances past every examined batch), so this is never a claim that a project was
 * skipped. Returns 0 when the pass has never run: nothing was skipped then.
 */
// lane-census: scope=project service=linear
export function mayBeUnminedLinearProjects(db: Database): number {
  const state = db
    .query(`SELECT watermark_ms, watermark_id, last_pass_at FROM premortem_pass_state WHERE id = 1`)
    .get() as { watermark_ms: number; watermark_id: string; last_pass_at: number | null } | null;
  if (state?.last_pass_at == null) {
    return 0;
  }
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item
        WHERE ${LINEAR_TRACKER.isEpicSql("item")}
          AND json_valid(metadata)
          AND json_extract(metadata, '$.status_category') IN ('done','canceled')
          AND (modified_at < ? OR (modified_at = ? AND id <= ?))
          AND NOT EXISTS (SELECT 1 FROM premortem_theme_evidence e WHERE e.item_id = item.id)`,
    )
    .get(state.watermark_ms, state.watermark_ms, state.watermark_id) as { n: number };
  return row.n;
}
