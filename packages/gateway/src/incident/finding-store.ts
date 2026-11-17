import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import { dbRun } from "../db/write.ts";

/**
 * The ONLY writer of `incident_finding` and `anomaly_baseline` (Phase 10 IC8, static D46(f), V103). A finding is
 * something the radar or the anomaly baseline NOTICED; nothing here, and nothing that reads these tables, acts on
 * it (D-IC-5, I57 (a)). Every statement uses bound parameters (I9, I14).
 *
 * At most one OPEN row per `(kind, finding_key)` (a partial UNIQUE index): {@link openFinding} inserts one or
 * refreshes the open one's `last_seen_at_ms` and detail, and reports whether it was new; {@link clearFinding} closes
 * the open one. `detail_json` is built by the caller from ids, times and numbers only and is refused over 4 KiB.
 */

export type FindingKind = "radar" | "anomaly";

export const FINDING_DETAIL_MAX_BYTES = 4096;
/** A cleared finding is deleted this long after it cleared. */
export const FINDING_CLEARED_RETENTION_MS = 30 * 86_400_000;
/** Baseline buckets older than this (from the newest bucket written) are deleted. */
export const BASELINE_RETENTION_MS = 14 * 86_400_000;

export type FindingRow = {
  readonly id: string;
  readonly kind: FindingKind;
  readonly finding_key: string;
  readonly service: string | null;
  readonly detail_json: string;
  readonly opened_at_ms: number;
  readonly last_seen_at_ms: number;
  readonly cleared_at_ms: number | null;
};

export type FindingInput = {
  readonly kind: FindingKind;
  readonly key: string;
  readonly service: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly nowMs: number;
};

function newFindingId(): string {
  return `fnd_${randomBytes(8).toString("hex")}`;
}

function detailJson(detail: FindingInput["detail"]): string {
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json, "utf8") > FINDING_DETAIL_MAX_BYTES) {
    throw new Error("finding detail exceeds 4 KiB");
  }
  return json;
}

/** Open a finding, or refresh the open one. Returns `true` when a NEW open row was written. */
export function openFinding(db: Database, f: FindingInput): boolean {
  const detail = detailJson(f.detail);
  const refreshed = dbRun(
    db,
    `UPDATE incident_finding SET last_seen_at_ms = ?, detail_json = ?, service = ?
      WHERE kind = ? AND finding_key = ? AND cleared_at_ms IS NULL`,
    [f.nowMs, detail, f.service, f.kind, f.key],
  );
  if (refreshed.changes > 0) return false;
  dbRun(
    db,
    `INSERT INTO incident_finding (id, kind, finding_key, service, detail_json, opened_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newFindingId(), f.kind, f.key, f.service, detail, f.nowMs, f.nowMs],
  );
  return true;
}

/** Close the open finding for `(kind, key)`. Returns `true` when one was open. */
export function clearFinding(db: Database, kind: FindingKind, key: string, nowMs: number): boolean {
  return (
    dbRun(
      db,
      `UPDATE incident_finding SET cleared_at_ms = ?
        WHERE kind = ? AND finding_key = ? AND cleared_at_ms IS NULL`,
      [nowMs, kind, key],
    ).changes > 0
  );
}

/** The open keys of one kind (the radar and the baseline diff against them). */
export function openFindingKeys(db: Database, kind: FindingKind): Set<string> {
  const rows = db
    .query("SELECT finding_key FROM incident_finding WHERE kind = ? AND cleared_at_ms IS NULL")
    .all(kind) as { finding_key: string }[];
  return new Set(rows.map((r) => r.finding_key));
}

/** Open findings first (newest first), then, with `all`, cleared ones (newest cleared first). */
export function listFindings(db: Database, opts: { all: boolean; limit: number }): FindingRow[] {
  const where = opts.all ? "" : "WHERE cleared_at_ms IS NULL";
  return db
    .query(
      `SELECT id, kind, finding_key, service, detail_json, opened_at_ms, last_seen_at_ms, cleared_at_ms
         FROM incident_finding ${where}
        ORDER BY (cleared_at_ms IS NOT NULL), COALESCE(cleared_at_ms, opened_at_ms) DESC, id
        LIMIT ?`,
    )
    .all(opts.limit) as FindingRow[];
}

/** Delete findings that cleared before `beforeMs`. */
export function pruneClearedFindings(db: Database, beforeMs: number): number {
  return dbRun(
    db,
    "DELETE FROM incident_finding WHERE cleared_at_ms IS NOT NULL AND cleared_at_ms < ?",
    [beforeMs],
  ).changes;
}

export type BaselineBucket = { readonly seriesId: string; readonly bucketStartMs: number; readonly value: number };

/** Write buckets (an existing bucket is replaced), in ONE transaction. */
export function writeBaselineBuckets(db: Database, buckets: readonly BaselineBucket[]): void {
  if (buckets.length === 0) return;
  db.transaction(() => {
    for (const b of buckets) {
      dbRun(
        db,
        `INSERT INTO anomaly_baseline (series_id, bucket_start_ms, value) VALUES (?, ?, ?)
         ON CONFLICT (series_id, bucket_start_ms) DO UPDATE SET value = excluded.value`,
        [b.seriesId, b.bucketStartMs, b.value],
      );
    }
  })();
}

/** The buckets of one series in `[fromMs, toMs]`, oldest first. */
export function readBaselineBuckets(
  db: Database,
  seriesId: string,
  fromMs: number,
  toMs: number,
): { bucketStartMs: number; value: number }[] {
  const rows = db
    .query(
      `SELECT bucket_start_ms, value FROM anomaly_baseline
        WHERE series_id = ? AND bucket_start_ms >= ? AND bucket_start_ms <= ?
        ORDER BY bucket_start_ms`,
    )
    .all(seriesId, fromMs, toMs) as { bucket_start_ms: number; value: number }[];
  return rows.map((r) => ({ bucketStartMs: r.bucket_start_ms, value: r.value }));
}

/** The newest bucket written for any series with this prefix, or null. */
export function newestBucketMs(db: Database, seriesPrefix: string): number | null {
  const row = db
    .query(
      "SELECT MAX(bucket_start_ms) AS m FROM anomaly_baseline WHERE series_id >= ? AND series_id < ?",
    )
    .get(seriesPrefix, `${seriesPrefix}￿`) as { m: number | null } | null;
  return row?.m ?? null;
}

/** Delete buckets that started before `beforeMs`. */
export function pruneBaselineBuckets(db: Database, beforeMs: number): number {
  return dbRun(db, "DELETE FROM anomaly_baseline WHERE bucket_start_ms < ?", [beforeMs]).changes;
}
