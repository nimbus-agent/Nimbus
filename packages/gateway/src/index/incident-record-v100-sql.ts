/**
 * V100 - incident records and their versions (Phase 10 IC3, incident-engine spec § 5.3).
 *
 * `incident_record`: one row per trigger item (a PagerDuty incident, a JSM Operations alert, a Sentry error
 * issue, a Monte Carlo or Bigeye data-quality item), assembled from the local index only. `record_json` is
 * the structured record (`IncidentRecordV1`), `markdown` its deterministic render. `record_sha256` is the
 * hash of the factual core, so an unchanged re-assembly writes no version. `assembled_at_ms` is when the
 * stored version's content was assembled; `checked_at_ms` is when the engine last re-assembled it (changed
 * or not), so a closed record is not re-selected for ever.
 * `incident_record_version`: the immutable `record_json` of every version, so replay shows what was known when.
 *
 * Written ONLY by `incident/incident-store.ts` (static D46(d)).
 *
 * NO foreign key to `item`, by design: an upstream deletion must not erase the record that says the incident
 * existed (as `item_history`, V94). NO CHECK on `trigger_service`: SQLite cannot alter a CHECK in place, so the
 * closed set of sources lives in `incident/trigger-sources.ts`. An owner erasure deletes the records that cite
 * the erased service (`incident/incident-erasure.ts`).
 *
 * Backfill: none. The next engine pass, or `nimbus incident show`, assembles. Re-runnable (IF NOT EXISTS only).
 */
export const INCIDENT_RECORD_V100_SQL = [
  `CREATE TABLE IF NOT EXISTS incident_record (
  id               TEXT PRIMARY KEY,
  trigger_item_id  TEXT NOT NULL UNIQUE,
  trigger_service  TEXT NOT NULL,
  trigger_type     TEXT NOT NULL,
  service          TEXT,
  title            TEXT NOT NULL,
  severity         TEXT,
  opened_at_ms     INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('open', 'closed', 'unknown')),
  version          INTEGER NOT NULL CHECK (version >= 1),
  assembled_at_ms  INTEGER NOT NULL,
  checked_at_ms    INTEGER NOT NULL,
  record_sha256    TEXT NOT NULL,
  cited_services   TEXT NOT NULL,
  record_json      TEXT NOT NULL CHECK (length(CAST(record_json AS BLOB)) <= 131072),
  markdown         TEXT NOT NULL CHECK (length(CAST(markdown AS BLOB)) <= 131072)
)`,
  "CREATE INDEX IF NOT EXISTS incident_record_open ON incident_record (status, opened_at_ms DESC, id)",
  "CREATE INDEX IF NOT EXISTS incident_record_service ON incident_record (service, opened_at_ms DESC, id)",
  "CREATE INDEX IF NOT EXISTS incident_record_opened ON incident_record (opened_at_ms DESC, id)",
  "CREATE INDEX IF NOT EXISTS incident_record_retention ON incident_record (opened_at_ms, assembled_at_ms)",
  "CREATE INDEX IF NOT EXISTS incident_record_checked ON incident_record (status, checked_at_ms, id)",
  `CREATE TABLE IF NOT EXISTS incident_record_version (
  record_id       TEXT NOT NULL REFERENCES incident_record(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version >= 1),
  assembled_at_ms INTEGER NOT NULL,
  record_sha256   TEXT NOT NULL,
  cited_services  TEXT NOT NULL,
  record_json     TEXT NOT NULL CHECK (length(CAST(record_json AS BLOB)) <= 131072),
  PRIMARY KEY (record_id, version)
) WITHOUT ROWID`,
];
