import type { Database } from "bun:sqlite";

import { dbRun, dbStmtRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";

/**
 * The ONLY code that names `extension_network_observation` / `extension_observation_coverage`
 * (V81). Evidence only: nothing here is read to decide a spawn, a grant, an approval or a network
 * rule.
 */
export const OBSERVATION_SCHEMA_VERSION = 81;
/** At most this many observation rows per extension and version; further keys add to `dropped`. */
export const MAX_OBSERVATION_ROWS = 512;
/** Rows and coverage age out this long after `last_seen`. */
export const OBSERVATION_RETENTION_MS = 90 * 86_400_000;

export type ObservationOutcome = "used" | "refused" | "unmatched";

export type ObservationEntry = {
  outcome: ObservationOutcome;
  destination: string;
  port: number;
  count: number;
};

export type ObservationWindow = {
  /** The window file's run, `<serviceId>.<runStartMs>.<8 hex>`; with `seq`, applied at most once. */
  runKey: string;
  seq: number;
  extensionId: string;
  version: string;
  os: "linux" | "darwin" | "win32";
  networkObserved: boolean;
  runStart: boolean;
  fromMs: number;
  toMs: number;
  entries: readonly ObservationEntry[];
  dropped: number;
};

export type ObservationRow = {
  extension_id: string;
  version: string;
  destination: string;
  port: number;
  outcome: ObservationOutcome;
  first_seen: number;
  last_seen: number;
  count: number;
};

export type CoverageRow = {
  extension_id: string;
  version: string;
  os: "linux" | "darwin" | "win32";
  runs: number;
  observed_ms: number;
  first_seen: number;
  last_seen: number;
  dropped: number;
  network_observed: number;
};

/**
 * Applies one window in ONE transaction: the applied mark, entry upserts (bounded per extension and
 * version), then coverage. A `(runKey, seq)` already marked is a no-op returning false, so a window
 * file counts once however often it is read. `network_observed` is sticky (an OR over every window
 * applied), so a run that was observed in any window stays observed whatever its other files say.
 * `appliedAtMs` dates the mark for the 90-day age-out.
 */
export function applyObservationWindow(
  db: Database,
  w: ObservationWindow,
  appliedAtMs: number = w.toMs,
): boolean {
  const markStmt = db.prepare(
    `INSERT INTO extension_observation_applied (run_key, seq, extension_id, applied_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(run_key, seq) DO NOTHING`,
  );
  const countStmt = db.query(
    "SELECT COUNT(*) AS n FROM extension_network_observation WHERE extension_id = ? AND version = ?",
  );
  const existsStmt = db.query(
    `SELECT 1 AS x FROM extension_network_observation
     WHERE extension_id = ? AND version = ? AND destination = ? AND port = ? AND outcome = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO extension_network_observation
       (extension_id, version, destination, port, outcome, first_seen, last_seen, count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(extension_id, version, destination, port, outcome) DO UPDATE SET
       count = count + excluded.count,
       first_seen = MIN(first_seen, excluded.first_seen),
       last_seen = MAX(last_seen, excluded.last_seen)`,
  );
  try {
    return db
      .transaction((): boolean => {
        if (dbStmtRun(markStmt, w.runKey, w.seq, w.extensionId, appliedAtMs).changes === 0) {
          return false;
        }
        let rows = (countStmt.get(w.extensionId, w.version) as { n: number }).n;
        let overflow = 0;
        for (const e of w.entries) {
          const known =
            existsStmt.get(w.extensionId, w.version, e.destination, e.port, e.outcome) !== null;
          if (!known && rows >= MAX_OBSERVATION_ROWS) {
            overflow += 1;
            continue;
          }
          dbStmtRun(
            upsert,
            w.extensionId,
            w.version,
            e.destination,
            e.port,
            e.outcome,
            w.fromMs,
            w.toMs,
            e.count,
          );
          if (!known) rows += 1;
        }
        dbRun(
          db,
          `INSERT INTO extension_observation_coverage
           (extension_id, version, os, runs, observed_ms, first_seen, last_seen, dropped, network_observed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(extension_id, version) DO UPDATE SET
           os = excluded.os,
           runs = runs + excluded.runs,
           observed_ms = observed_ms + excluded.observed_ms,
           first_seen = MIN(first_seen, excluded.first_seen),
           last_seen = MAX(last_seen, excluded.last_seen),
           dropped = dropped + excluded.dropped,
           network_observed = MAX(network_observed, excluded.network_observed)`,
          [
            w.extensionId,
            w.version,
            w.os,
            w.runStart ? 1 : 0,
            Math.max(0, w.toMs - w.fromMs),
            w.fromMs,
            w.toMs,
            w.dropped + overflow,
            w.networkObserved ? 1 : 0,
          ],
        );
        return true;
        // IMMEDIATE: the write lock is taken before the row count is read, so the 512 bound and the
        // writes it decides cannot be interleaved with another writer.
      })
      .immediate();
  } finally {
    markStmt.finalize();
    countStmt.finalize();
    existsStmt.finalize();
    upsert.finalize();
  }
}

/** Deletes rows and coverage whose `last_seen` is older than 90 days; returns rows deleted. */
export function ageOutObservations(db: Database, nowMs: number): number {
  const cutoff = nowMs - OBSERVATION_RETENTION_MS;
  let deleted = 0;
  db.transaction(() => {
    deleted = dbRun(db, "DELETE FROM extension_network_observation WHERE last_seen < ?", [
      cutoff,
    ]).changes;
    dbRun(db, "DELETE FROM extension_observation_coverage WHERE last_seen < ?", [cutoff]);
    dbRun(db, "DELETE FROM extension_observation_applied WHERE applied_at < ?", [cutoff]);
  })();
  return deleted;
}

export function readExtensionAudit(
  db: Database,
  extensionId: string,
  version: string,
): { coverage: CoverageRow | undefined; rows: ObservationRow[] } {
  const coverage = db
    .query("SELECT * FROM extension_observation_coverage WHERE extension_id = ? AND version = ?")
    .get(extensionId, version) as CoverageRow | null;
  const rows = db
    .query(
      `SELECT * FROM extension_network_observation WHERE extension_id = ? AND version = ?
       ORDER BY outcome, destination, port`,
    )
    .all(extensionId, version) as ObservationRow[];
  return { coverage: coverage ?? undefined, rows };
}

/** Removes every V81 row of an extension. A no-op below V81, where the tables do not exist. */
export function deleteObservationsFor(db: Database, extensionId: string): void {
  if (readIndexedUserVersion(db) < OBSERVATION_SCHEMA_VERSION) return;
  dbRun(db, "DELETE FROM extension_network_observation WHERE extension_id = ?", [extensionId]);
  dbRun(db, "DELETE FROM extension_observation_coverage WHERE extension_id = ?", [extensionId]);
  dbRun(db, "DELETE FROM extension_observation_applied WHERE extension_id = ?", [extensionId]);
}
