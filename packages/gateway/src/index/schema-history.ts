import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type { SchemaColumn, SchemaObservation } from "./schema-history-source.ts";

/**
 * The ONLY module with a write verb on `schema_history` (Phase 10, schema V108, static D24 rule
 * `schema-history-confined`). Callers: `index/item-write-tracking.ts` (every upsert of a tracked warehouse
 * item), the two owner-erasure paths (`deleteAllItemsForService`, `runDataDelete`) and the retention tick.
 *
 * Rows are written only when an observation CHANGES what the latest row for the table says, so a sync every
 * ten minutes over an unchanged table costs one indexed read and no write. An incomplete observation is a row
 * of its own (`complete = 0`, no columns) and is never repeated: a table that stays incomplete writes one.
 */

function sameColumns(a: readonly SchemaColumn[], b: readonly SchemaColumn[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.name !== y.name || x.type !== y.type || x.nullable !== y.nullable) return false;
  }
  return true;
}

type LatestRow = { complete: number; columns_json: string | null };

function latestFor(db: Database, service: string, key: string): LatestRow | null {
  const stmt = db.prepare(
    `SELECT complete, columns_json FROM schema_history
      WHERE service = ? AND data_model_key = ? ORDER BY id DESC LIMIT 1`,
  );
  try {
    return (stmt.get(service, key) as LatestRow | null) ?? null;
  } finally {
    stmt.finalize();
  }
}

function parseStored(text: string | null): SchemaColumn[] | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? (v as SchemaColumn[]) : null;
  } catch {
    return null;
  }
}

/**
 * Records one observation. Returns true when a row was written. A first observation is a baseline row (a
 * change needs two); an unchanged complete set and a repeated incomplete one write nothing.
 */
export function recordSchemaObservation(
  db: Database,
  obs: SchemaObservation,
  observedAtMs: number,
): boolean {
  const latest = latestFor(db, obs.service, obs.key);
  if (obs.columns === null) {
    if (latest !== null && latest.complete === 0) return false;
    dbRun(
      db,
      `INSERT INTO schema_history
         (service, data_model_key, observed_at_ms, complete, column_count, columns_json)
       VALUES (?, ?, ?, 0, NULL, NULL)`,
      [obs.service, obs.key, observedAtMs],
    );
    return true;
  }
  if (latest !== null && latest.complete === 1) {
    const prev = parseStored(latest.columns_json);
    if (prev !== null && sameColumns(prev, obs.columns)) return false;
  }
  dbRun(
    db,
    `INSERT INTO schema_history
       (service, data_model_key, observed_at_ms, complete, column_count, columns_json)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [obs.service, obs.key, observedAtMs, obs.columns.length, JSON.stringify(obs.columns)],
  );
  return true;
}

/** An owner erasure (`connector remove`, `nimbus data delete`): the service's schema history goes with it. */
export function deleteSchemaHistoryForService(db: Database, service: string): void {
  dbRun(db, "DELETE FROM schema_history WHERE service = ?", [service]);
}

export type SchemaHistoryPruneResult = {
  readonly deleted: number;
  /** True when the last batch was full (more rows may remain). */
  readonly more: boolean;
};

/**
 * Deletes observations with `observed_at_ms < cutoffMs`, in batches, but never the NEWEST row of a table:
 * that row is the baseline the next diff is taken against, so retention only forgets older changes.
 */
export function pruneSchemaHistory(
  db: Database,
  opts: { readonly cutoffMs: number; readonly batchSize: number; readonly maxBatches: number },
): SchemaHistoryPruneResult {
  let deleted = 0;
  let more = false;
  for (let b = 0; b < opts.maxBatches; b++) {
    const r = dbRun(
      db,
      `DELETE FROM schema_history WHERE id IN (
         SELECT h.id FROM schema_history h
          WHERE h.observed_at_ms < ?
            AND h.id <> (SELECT MAX(n.id) FROM schema_history n
                          WHERE n.service = h.service AND n.data_model_key = h.data_model_key)
          ORDER BY h.observed_at_ms LIMIT ?)`,
      [opts.cutoffMs, opts.batchSize],
    );
    deleted += r.changes;
    more = r.changes === opts.batchSize;
    if (!more) break;
  }
  return { deleted, more };
}
