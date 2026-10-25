import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { sourceTypesFor } from "./source-kinds.ts";

/**
 * Catch-up for source types that joined a pass's mapping (decisions or glossary) after the main cursor passed their
 * items (schema V74 `source_catchup_state`, spec § 6).
 *
 * Each pass keeps ONE composite cursor (e.g. `decision_pass_state`). A type mapped later sits behind it
 * forever, and a type unmapped for a while misses everything modified in that window. Each type
 * therefore carries its own cursor here, scanned from where it stopped up to the main cursor the
 * run started at. Catch-up writes ONLY this table: writing an older cursor into
 * `decision_pass_state` would rewind the main watermark and re-scan the whole index.
 */

export type CatchupPass = "decisions" | "glossary";

export type CatchupCursor = { readonly watermarkMs: number; readonly watermarkId: string };

export type CatchupType = { readonly serviceType: string } & CatchupCursor;

const ZERO: CatchupCursor = { watermarkMs: 0, watermarkId: "" };

function writeRow(
  db: Database,
  pass: CatchupPass,
  serviceType: string,
  cursor: CatchupCursor,
  done: boolean,
): void {
  dbRun(
    db,
    `INSERT INTO source_catchup_state (pass, service_type, watermark_ms, watermark_id, done)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pass, service_type) DO UPDATE SET
       watermark_ms = excluded.watermark_ms,
       watermark_id = excluded.watermark_id,
       done         = excluded.done`,
    [pass, serviceType, cursor.watermarkMs, cursor.watermarkId, done ? 1 : 0],
  );
}

/**
 * Run-start bookkeeping, in its own transaction, before catch-up and the delta scan.
 *
 * - An effective type with no row: a built-in one is already covered by the main cursor, so it
 *   starts `done` there; any other starts not-done from the beginning of time.
 * - A built-in type that is NOT effective and has no row (an owner excluded it before the first
 *   run after V74) is parked not-done at the main cursor: everything up to here was mined while
 *   no mapping existed, and only what is modified while it stays excluded must be caught up.
 * - A `done` row whose type left the set re-opens at the main cursor of this moment, so a later
 *   re-add scans only the window it was unmapped for.
 * - A not-done row whose type left the set is left alone; its cursor is still correct.
 */
export function reconcileCatchupRows(
  db: Database,
  pass: CatchupPass,
  effective: readonly string[],
  builtin: ReadonlySet<string>,
  mainCursor: CatchupCursor,
): void {
  db.transaction(() => {
    const rows = db
      .query("SELECT service_type, done FROM source_catchup_state WHERE pass = ?")
      .all(pass) as { service_type: string; done: number }[];
    const known = new Map(rows.map((r) => [r.service_type, r.done === 1]));
    const eff = new Set(effective);
    for (const serviceType of new Set([...effective, ...builtin])) {
      if (known.has(serviceType)) continue;
      const covered = builtin.has(serviceType);
      writeRow(db, pass, serviceType, covered ? mainCursor : ZERO, covered && eff.has(serviceType));
    }
    for (const [serviceType, done] of known) {
      if (done && !eff.has(serviceType)) writeRow(db, pass, serviceType, mainCursor, false);
    }
  })();
}

/** The effective types still to catch up, with their cursors, in a stable order. */
export function catchupTypes(
  db: Database,
  pass: CatchupPass,
  effective: readonly string[],
): readonly CatchupType[] {
  const eff = new Set(effective);
  const rows = db
    .query(
      `SELECT service_type, watermark_ms, watermark_id FROM source_catchup_state
        WHERE pass = ? AND done = 0
        ORDER BY service_type ASC`,
    )
    .all(pass) as { service_type: string; watermark_ms: number; watermark_id: string }[];
  return rows
    .filter((r) => eff.has(r.service_type))
    .map((r) => ({
      serviceType: r.service_type,
      watermarkMs: r.watermark_ms,
      watermarkId: r.watermark_id,
    }));
}

export interface CatchupRun<R extends { id: string; modified_at: number }> {
  readonly pass: CatchupPass;
  readonly batchLimit: number;
  /** Batches this run may spend; shared with the delta scan, which gets what is left. */
  readonly maxBatches: number;
  /** Re-checked before every batch, so a type that leaves the mapping mid-run stops. */
  readonly isEffective: (serviceType: string) => boolean;
  /** Rows of ONE type strictly after `after`, up to and including the run-start main cursor. */
  readonly scan: (serviceType: string, after: CatchupCursor, limit: number) => R[];
  /** Mines the rows; called inside the transaction that advances the type's cursor. */
  readonly mine: (rows: readonly R[]) => number;
}

export interface CatchupSummary {
  readonly batches: number;
  readonly scanned: number;
  readonly discovered: number;
  /** `false` when the batch budget ran out with a type still behind the main cursor. */
  readonly complete: boolean;
}

/**
 * Drains each type in bounded batches. Every batch commits its mined rows and the type's advanced
 * cursor together; a batch shorter than the limit (an empty one included) reaches the upper bound,
 * so the type is marked `done` in that same transaction.
 */
export function runCatchup<R extends { id: string; modified_at: number }>(
  db: Database,
  types: readonly CatchupType[],
  run: CatchupRun<R>,
): CatchupSummary {
  let batches = 0;
  let scanned = 0;
  let discovered = 0;
  for (const t of types) {
    let cursor: CatchupCursor = { watermarkMs: t.watermarkMs, watermarkId: t.watermarkId };
    while (run.isEffective(t.serviceType)) {
      if (batches >= run.maxBatches) return { batches, scanned, discovered, complete: false };
      batches++;
      const rows = run.scan(t.serviceType, cursor, run.batchLimit);
      const last = rows.at(-1);
      const next =
        last === undefined ? cursor : { watermarkMs: last.modified_at, watermarkId: last.id };
      const done = rows.length < run.batchLimit;
      db.transaction(() => {
        discovered += run.mine(rows);
        writeRow(db, run.pass, t.serviceType, next, done);
      })();
      scanned += rows.length;
      cursor = next;
      if (done) break;
    }
  }
  return { batches, scanned, discovered, complete: true };
}

/**
 * Every type this pass has ever tracked: the built-ins in table order, then each other
 * `service_type` with a `source_catchup_state` row for THIS pass, in `service_type` order.
 */
export function knownSourceTypes(db: Database, pass: CatchupPass): readonly string[] {
  const builtin = sourceTypesFor(pass);
  const have = new Set(builtin);
  const rows = db
    .query("SELECT service_type FROM source_catchup_state WHERE pass = ? ORDER BY service_type ASC")
    .all(pass) as { service_type: string }[];
  const extra = rows.map((r) => r.service_type).filter((t) => !have.has(t));
  return Object.freeze([...builtin, ...extra]);
}

/** Columns both passes' scan rows carry (decisions `ScanRow`, glossary `ScanRow`). */
export const SCAN_COLUMNS =
  "i.id, i.service, i.type, i.title, i.body, i.body_complete, i.modified_at";

/**
 * One catch-up batch: ONE type, strictly after its own cursor, up to and including the main cursor
 * the run started at. `service`/`type` are matched as two equality columns, never the
 * concatenation, so `idx_item_service_type_modified (service, type, modified_at, id)` (V74) serves
 * both the range and the ORDER BY: each batch seeks to its window, with no sort. The bounds are
 * row-value comparisons on purpose — the equivalent `a > ? OR (a = ? AND b > ?)` form keeps the
 * index for the ORDER BY but not for the range, so every batch would re-read the type from its
 * first item. Exported for the query-plan test that pins this.
 */
export const CATCHUP_SCAN_SQL = `SELECT ${SCAN_COLUMNS}
         FROM item i
        WHERE i.service = ? AND i.type = ?
          AND (i.modified_at, i.id) > (?, ?)
          AND (i.modified_at, i.id) <= (?, ?)
        ORDER BY i.modified_at ASC, i.id ASC
        LIMIT ?`;
