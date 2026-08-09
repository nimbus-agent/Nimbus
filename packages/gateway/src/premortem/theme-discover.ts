import type { Database } from "bun:sqlite";

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

/**
 * Resumes STRICTLY after `(watermarkMs, watermarkId)`. The composite tie-break
 * matters: a bulk import stamps thousands of rows with one `modified_at`, and
 * `modified_at > ?` alone would skip every row after the first in that group
 * while `>=` would re-scan them forever.
 */
export function discoverClosedEpics(
  db: Database,
  opts: { watermarkMs: number; watermarkId: string; batchSize: number },
): DiscoveredEpic[] {
  const rows = db
    .query(
      `SELECT id, external_id, title, body, body_complete, metadata, modified_at
         FROM item
        WHERE service = 'jira'
          AND json_extract(metadata, '$.status_category') IN ('done','canceled')
          AND json_extract(metadata, '$.issue_type') = 'Epic'
          AND (modified_at > ? OR (modified_at = ? AND id > ?))
        ORDER BY modified_at ASC, id ASC
        LIMIT ?`,
    )
    .all(opts.watermarkMs, opts.watermarkMs, opts.watermarkId, opts.batchSize) as Array<{
    id: string;
    external_id: string;
    title: string;
    body: string | null;
    body_complete: number;
    metadata: string;
    modified_at: number;
  }>;

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
