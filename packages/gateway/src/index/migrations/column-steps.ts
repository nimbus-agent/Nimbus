import type { Database } from "bun:sqlite";

import { dbExec, dbRun } from "../../db/write.ts";
import { CAPTURE_LABEL_SOURCE_V99_SQL } from "../capture-label-source-v99-sql.ts";
import { EXTENSION_PROVENANCE_V105_SQL } from "../extension-provenance-v105-sql.ts";
import { INCIDENT_EXECUTED_AT_V106_SQL } from "../incident-executed-at-v106-sql.ts";
import { USER_MCP_WRITE_V98_SQL } from "../user-mcp-write-v98-sql.ts";

/**
 * Migration steps that add a column, kept out of `runner.ts` (which may not grow). Each is guarded by a
 * column probe: SQLite has no `ADD COLUMN IF NOT EXISTS`, and a step must be re-runnable (the migration
 * suites rewind `user_version` and run every step again).
 */

function recordMigration(db: Database, version: number, description: string, now: number): void {
  dbRun(
    db,
    `INSERT OR IGNORE INTO _schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
    [version, description, now],
  );
}

function hasColumn(db: Database, table: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === columnName);
}

/**
 * V105 - `extension.provenance_json` and `extension.provenance_bundle` (offline provenance
 * re-verification, slice 2; I51).
 */
export function migrateIndexedV104ToV105(db: Database, now: number): void {
  db.transaction(() => {
    const [jsonSql, bundleSql] = EXTENSION_PROVENANCE_V105_SQL;
    if (jsonSql !== undefined && !hasColumn(db, "extension", "provenance_json"))
      dbExec(db, jsonSql);
    if (bundleSql !== undefined && !hasColumn(db, "extension", "provenance_bundle")) {
      dbExec(db, bundleSql);
    }
    dbExec(db, "PRAGMA user_version = 105");
    recordMigration(db, 105, "installed extension provenance and Sigstore bundle", now);
  })();
}

/**
 * V106 - `incident_proposal.executed_at_ms` (the incident engine, `nimbus incident undo` with no id). The
 * backfill takes `updated_at_ms` for an executed row that was never undone: nothing else touches such a row
 * after its run finished, so it is the time the run ended.
 */
export function migrateIndexedV105ToV106(db: Database, now: number): void {
  db.transaction(() => {
    const [alterSql, backfillSql] = INCIDENT_EXECUTED_AT_V106_SQL;
    if (alterSql !== undefined && !hasColumn(db, "incident_proposal", "executed_at_ms")) {
      dbExec(db, alterSql);
    }
    if (backfillSql !== undefined) dbExec(db, backfillSql);
    dbExec(db, "PRAGMA user_version = 106");
    recordMigration(
      db,
      106,
      "incident proposal executed-at time (nimbus incident undo, no id)",
      now,
    );
  })();
}

/**
 * V98 - `user_mcp_connector.write_paths_json` (Phase 28 AD5b, I15). Guarded by a column probe, as V95 is:
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and a step must be re-runnable.
 */
export function migrateIndexedV97ToV98(db: Database, now: number): void {
  db.transaction(() => {
    if (!hasColumn(db, "user_mcp_connector", "write_paths_json")) {
      dbExec(db, USER_MCP_WRITE_V98_SQL.trim());
    }
    dbExec(db, "PRAGMA user_version = 98");
    recordMigration(db, 98, "user MCP write directories (Phase 28 AD5b)", now);
  })();
}

/** V99 - `capture.label_source` (Phase 28 AD7a, D-AD-13). Guarded by a column probe, as V98 is. */
export function migrateIndexedV98ToV99(db: Database, now: number): void {
  db.transaction(() => {
    if (!hasColumn(db, "capture", "label_source")) {
      dbExec(db, CAPTURE_LABEL_SOURCE_V99_SQL.trim());
    }
    dbExec(db, "PRAGMA user_version = 99");
    recordMigration(db, 99, "capture label source (Phase 28 AD7a)", now);
  })();
}
