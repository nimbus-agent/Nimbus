import type { Database } from "bun:sqlite";

import { dbRun, dbStmtRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";

/**
 * The ONLY code that names `extension_network_observation` / `extension_observation_coverage`
 * (V81) and `extension_observation_notice` (V82). Evidence only: nothing here is read to decide a
 * spawn, a grant, an approval or a network rule.
 */
export const OBSERVATION_SCHEMA_VERSION = 81;
/** The schema version that adds `extension_observation_notice`, the notification's rate state. */
export const OBSERVATION_NOTICE_SCHEMA_VERSION = 82;
/**
 * At most this many observation rows per extension and version. Past it a new `used` key evicts
 * the oldest `unmatched` (else `refused`) row; any other new key, or a `used` key with nothing to
 * evict, is not stored. Either way one key adds one to `dropped`.
 */
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
  /** The run's last file at the one-day bound: the writer stopped writing. Absent means false. */
  stopped?: boolean;
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
  /** 1 once any run of this version stopped at the one-day bound; sticky like `network_observed`. */
  stopped: number;
};

/** The window's coverage, in the caller's transaction; `overflow` is what the 512 bound turned away. */
function upsertCoverage(db: Database, w: ObservationWindow, overflow: number): void {
  dbRun(
    db,
    `INSERT INTO extension_observation_coverage
       (extension_id, version, os, runs, observed_ms, first_seen, last_seen, dropped, network_observed, stopped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(extension_id, version) DO UPDATE SET
       os = excluded.os,
       runs = runs + excluded.runs,
       observed_ms = observed_ms + excluded.observed_ms,
       first_seen = MIN(first_seen, excluded.first_seen),
       last_seen = MAX(last_seen, excluded.last_seen),
       dropped = dropped + excluded.dropped,
       network_observed = MAX(network_observed, excluded.network_observed),
       stopped = MAX(stopped, excluded.stopped)`,
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
      w.stopped === true ? 1 : 0,
    ],
  );
}

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
  /** The oldest `unmatched` row of this extension and version, else the oldest `refused` one. */
  const evictStmt = db.prepare(
    `DELETE FROM extension_network_observation WHERE rowid = (
       SELECT rowid FROM extension_network_observation
       WHERE extension_id = ? AND version = ? AND outcome IN ('unmatched', 'refused')
       ORDER BY outcome = 'refused', last_seen, first_seen, destination, port
       LIMIT 1)`,
  );
  /** Whether room was made for a new entry at the bound: only a `used` one, and only by eviction. */
  const evictedFor = (e: ObservationEntry): boolean =>
    e.outcome === "used" && dbStmtRun(evictStmt, w.extensionId, w.version).changes > 0;
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
            // At the bound: a new `used` row takes the place of the oldest `unmatched` (else
            // `refused`) row, so addresses that matched nothing cannot crowd out a declared host
            // and make the report call it "not seen". The evicted row is what is dropped.
            overflow += 1;
            if (!evictedFor(e)) continue;
            rows -= 1;
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
        upsertCoverage(db, w, overflow);
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
    evictStmt.finalize();
  }
}

/**
 * Deletes rows and coverage whose `last_seen` is older than 90 days, and (from V82) notices 90
 * days after `last_notified_at`; returns rows deleted.
 */
export function ageOutObservations(db: Database, nowMs: number): number {
  const cutoff = nowMs - OBSERVATION_RETENTION_MS;
  const notices = readIndexedUserVersion(db) >= OBSERVATION_NOTICE_SCHEMA_VERSION;
  let deleted = 0;
  db.transaction(() => {
    deleted = dbRun(db, "DELETE FROM extension_network_observation WHERE last_seen < ?", [
      cutoff,
    ]).changes;
    dbRun(db, "DELETE FROM extension_observation_coverage WHERE last_seen < ?", [cutoff]);
    dbRun(db, "DELETE FROM extension_observation_applied WHERE applied_at < ?", [cutoff]);
    if (notices) {
      dbRun(db, "DELETE FROM extension_observation_notice WHERE last_notified_at < ?", [cutoff]);
    }
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

/**
 * Removes every V81 row of an extension, and its V82 notices. A no-op below V81, where the tables
 * do not exist; the notice delete runs only from V82.
 */
export function deleteObservationsFor(db: Database, extensionId: string): void {
  const version = readIndexedUserVersion(db);
  if (version < OBSERVATION_SCHEMA_VERSION) return;
  dbRun(db, "DELETE FROM extension_network_observation WHERE extension_id = ?", [extensionId]);
  dbRun(db, "DELETE FROM extension_observation_coverage WHERE extension_id = ?", [extensionId]);
  dbRun(db, "DELETE FROM extension_observation_applied WHERE extension_id = ?", [extensionId]);
  if (version < OBSERVATION_NOTICE_SCHEMA_VERSION) return;
  dbRun(db, "DELETE FROM extension_observation_notice WHERE extension_id = ?", [extensionId]);
}

/** When the owner was last notified about this extension version's findings; `undefined` if never. */
export function readNoticeAt(
  db: Database,
  extensionId: string,
  version: string,
): number | undefined {
  const row = db
    .query(
      "SELECT last_notified_at FROM extension_observation_notice WHERE extension_id = ? AND version = ?",
    )
    .get(extensionId, version) as { last_notified_at: number } | null;
  return row?.last_notified_at;
}

/** Records that the owner was notified about this extension version at `atMs`. */
export function recordNotice(
  db: Database,
  extensionId: string,
  version: string,
  atMs: number,
): void {
  dbRun(
    db,
    `INSERT INTO extension_observation_notice (extension_id, version, last_notified_at)
     VALUES (?, ?, ?)
     ON CONFLICT(extension_id, version) DO UPDATE SET last_notified_at = excluded.last_notified_at`,
    [extensionId, version, atMs],
  );
}
