/**
 * V103 - the incident engine's predictions (Phase 10 IC8, incident-engine spec § 5.8): the radar's and the anomaly
 * baseline's findings, and the persisted hourly buckets the baseline scores against.
 *
 * `incident_finding`: one row per finding. `kind` is `radar` (an expected event is overdue) or `anomaly` (a series
 * bucket or sync sample far above its baseline). `finding_key` names what it is about (`deploy:<service>`,
 * `index:errors:<service>`, `sync:duration_ms:<connector>`); at most ONE open row per `(kind, finding_key)` (the
 * partial UNIQUE index), so a re-detected finding updates `last_seen_at_ms` instead of piling up. `detail_json` holds
 * ids, times and numbers only, never indexed text, capped at 4 KiB. `cleared_at_ms` is set when the event recurs or
 * the series falls back under the threshold; a cleared row is pruned after 30 days.
 *
 * `anomaly_baseline`: one row per (series, hourly bucket) with its count; zeros are stored, so a missing row is a gap
 * (a capped or failed scan), never a zero. Pruned past 14 days.
 *
 * Written ONLY by `incident/finding-store.ts` (static D46(f)). Detection never acts (D-IC-5, I57 (a)): nothing reads
 * these tables to dispatch anything. Backfill: none (the next predict pass fills the buckets from the index).
 * Re-runnable (IF NOT EXISTS only).
 */
export const INCIDENT_PREDICT_V103_SQL = [
  `CREATE TABLE IF NOT EXISTS incident_finding (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('radar', 'anomaly')),
  finding_key      TEXT NOT NULL CHECK (length(finding_key) BETWEEN 1 AND 256),
  service          TEXT,
  detail_json      TEXT NOT NULL CHECK (length(CAST(detail_json AS BLOB)) <= 4096),
  opened_at_ms     INTEGER NOT NULL,
  last_seen_at_ms  INTEGER NOT NULL,
  cleared_at_ms    INTEGER
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS incident_finding_open ON incident_finding (kind, finding_key) WHERE cleared_at_ms IS NULL",
  "CREATE INDEX IF NOT EXISTS incident_finding_recent ON incident_finding (cleared_at_ms, opened_at_ms DESC, id)",
  `CREATE TABLE IF NOT EXISTS anomaly_baseline (
  series_id        TEXT NOT NULL,
  bucket_start_ms  INTEGER NOT NULL,
  value            REAL NOT NULL,
  PRIMARY KEY (series_id, bucket_start_ms)
) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS anomaly_baseline_bucket ON anomaly_baseline (bucket_start_ms)",
];
