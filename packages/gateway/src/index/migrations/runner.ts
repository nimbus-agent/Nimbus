import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { CONNECTOR_REMOVE_INTENT_V15_SQL } from "../../connectors/remove-intent.ts";
import { computeAuditRowHash } from "../../db/audit-chain.ts";
import { dbExec, dbRun, dbStmtRun } from "../../db/write.ts";
import { API_ENDPOINT_V25_SCHEMA_SQL } from "../api-endpoint-v25-sql.ts";
import { AUDIT_CHAIN_V18_SCHEMA_SQL } from "../audit-chain-v18-sql.ts";
import { AUDIT_SESSION_V24_SCHEMA_SQL } from "../audit-session-v24-sql.ts";
import { CONNECTOR_DEPTH_V21_SQL } from "../connector-depth-v21-sql.ts";
import { CONNECTOR_HEALTH_V13_SQL } from "../connector-health-v13-sql.ts";
import { DEPLOYMENT_V28_SCHEMA_SQL } from "../deployment-v28-sql.ts";
import {
  EMBEDDING_V6_MIGRATION_SQL,
  EMBEDDING_V6_NO_VEC_MIGRATION_SQL,
} from "../embedding-v6-sql.ts";
import { V31_EXTENSION_DEPENDENCY_SQL } from "../extension-dependency-v31-sql.ts";
import {
  EXTENSION_SESSION_V10_MIGRATION_SQL,
  EXTENSION_SESSION_V10_NO_VEC_MIGRATION_SQL,
} from "../extension-session-v10-sql.ts";
import { GRAPH_RELATION_TYPES_V12_SQL } from "../graph-relation-types-v12-sql.ts";
import { GRAPH_V7_MIGRATION_SQL } from "../graph-v7-sql.ts";
import { LAN_PEERS_V19_SQL } from "../lan-peers-v19-sql.ts";
import { LLM_CONTEXT_WINDOW_V16_ALTER_SQL, LLM_MODELS_V16_SQL } from "../llm-models-v16-sql.ts";
import { LLM_TASK_DEFAULTS_V20_SQL } from "../llm-task-defaults-v20-sql.ts";
import {
  OBSIDIAN_NOTES_V26_SCHEMA_SQL,
  OBSIDIAN_NOTES_V26_SEED_SQL,
} from "../obsidian-notes-v26-sql.ts";
import { PERSON_HANDLES_V5_ALTER_SQL } from "../person-handles-v5-sql.ts";
import { PERSON_LINKED_V4_ALTER_SQL } from "../person-linked-v4-sql.ts";
import { PR_COMMIT_RELATION_V27_SEED_SQL } from "../pr-commit-relation-v27-sql.ts";
import { QUERY_LATENCY_V14_SQL } from "../query-latency-v14-sql.ts";
import { SCHEDULER_V2_MIGRATION_SQL } from "../scheduler-schema-sql.ts";
import { INITIAL_SCHEMA_SQL } from "../schema-sql.ts";
import { tryLoadSqliteVec } from "../sqlite-vec-load.ts";
import { SUB_TASK_RESULTS_V17_SQL } from "../sub-task-results-v17-sql.ts";
import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../tool-call-log-v29-sql.ts";
import {
  UNIFIED_ITEM_V3_MIGRATE_FROM_LEGACY_SQL,
  UNIFIED_ITEM_V3_SCHEMA_SQL,
} from "../unified-item-v3-sql.ts";
import { USER_MCP_V11_MIGRATION_SQL } from "../user-mcp-v11-sql.ts";
import {
  VEC_ITEMS_1536_V30_NO_VEC_SQL,
  VEC_ITEMS_1536_V30_SCHEMA_SQL,
} from "../vec-items-1536-v30-sql.ts";
import { WATCHER_GRAPH_V22_SQL } from "../watcher-graph-v22-sql.ts";
import { WATCHER_V8_MIGRATION_SQL } from "../watcher-v8-sql.ts";
import { WORKFLOW_RUN_COLUMNS_V23_SQL } from "../workflow-run-columns-v23-sql.ts";
import { WORKFLOW_V9_MIGRATION_SQL } from "../workflow-v9-sql.ts";

const MIGRATIONS_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS _schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

function personTableHasLinkedColumn(db: Database): boolean {
  const rows = db.query("PRAGMA table_info(person)").all() as Array<{ name: string }>;
  return rows.some((r) => r.name === "linked");
}

function personTableHasColumn(db: Database, columnName: string): boolean {
  const rows = db.query("PRAGMA table_info(person)").all() as Array<{ name: string }>;
  return rows.some((r) => r.name === columnName);
}

/** Current local index `PRAGMA user_version` (0 before first migration). */
export function readIndexedUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | undefined;
  const v = row?.user_version;
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

function recordMigration(db: Database, version: number, description: string, now: number): void {
  dbRun(
    db,
    `INSERT OR IGNORE INTO _schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
    [version, description, now],
  );
}

type IndexedSchemaStep = {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly apply: (db: Database, now: number) => void;
};

function migrateIndexedV0ToV1(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, INITIAL_SCHEMA_SQL);
    dbExec(db, "PRAGMA user_version = 1");
    recordMigration(db, 1, "initial filesystem schema", now);
  })();
}

function migrateIndexedV1ToV2(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, SCHEDULER_V2_MIGRATION_SQL);
    dbExec(db, "PRAGMA user_version = 2");
    recordMigration(db, 2, "scheduler_state + sync_telemetry", now);
  })();
}

function migrateIndexedV2ToV3(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, UNIFIED_ITEM_V3_SCHEMA_SQL);
    dbExec(db, UNIFIED_ITEM_V3_MIGRATE_FROM_LEGACY_SQL);
    dbExec(db, "PRAGMA user_version = 3");
    recordMigration(db, 3, "unified item + item_fts + person", now);
  })();
}

function migrateIndexedV3ToV4(db: Database, now: number): void {
  db.transaction(() => {
    if (!personTableHasLinkedColumn(db)) {
      dbExec(db, PERSON_LINKED_V4_ALTER_SQL.trim());
    }
    dbRun(
      db,
      `UPDATE person SET linked = 0 WHERE canonical_email IS NULL OR trim(canonical_email) = ''`,
    );
    dbExec(db, "PRAGMA user_version = 4");
    recordMigration(db, 4, "person.linked column", now);
  })();
}

function migrateIndexedV4ToV5(db: Database, now: number): void {
  db.transaction(() => {
    if (!personTableHasColumn(db, "bitbucket_uuid")) {
      dbExec(db, PERSON_HANDLES_V5_ALTER_SQL.trim());
    }
    dbExec(db, "PRAGMA user_version = 5");
    recordMigration(db, 5, "person bitbucket_uuid + microsoft_user_id + discord_user_id", now);
  })();
}

function migrateIndexedV5ToV6(db: Database, now: number): void {
  const vecLoaded = tryLoadSqliteVec(db);
  db.transaction(() => {
    dbExec(db, vecLoaded ? EMBEDDING_V6_MIGRATION_SQL : EMBEDDING_V6_NO_VEC_MIGRATION_SQL);
    dbExec(db, "PRAGMA user_version = 6");
    recordMigration(
      db,
      6,
      vecLoaded ? "embedding_chunk + vec_items_384" : "embedding_chunk (sqlite-vec unavailable)",
      now,
    );
  })();
}

function migrateIndexedV6ToV7(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, GRAPH_V7_MIGRATION_SQL);
    dbExec(db, "PRAGMA user_version = 7");
    recordMigration(db, 7, "graph_entity + graph_relation", now);
  })();
}

function migrateIndexedV7ToV8(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, WATCHER_V8_MIGRATION_SQL);
    dbExec(db, "PRAGMA user_version = 8");
    recordMigration(db, 8, "watcher + watcher_event", now);
  })();
}

function migrateIndexedV8ToV9(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, WORKFLOW_V9_MIGRATION_SQL);
    dbExec(db, "PRAGMA user_version = 9");
    recordMigration(db, 9, "workflow tables", now);
  })();
}

function vecTableExists(db: Database): boolean {
  const row = db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_items_384'`)
    .get() as { 1: number } | null;
  return row !== null;
}

function migrateIndexedV9ToV10(db: Database, now: number): void {
  const hasVec = vecTableExists(db);
  db.transaction(() => {
    dbExec(
      db,
      hasVec ? EXTENSION_SESSION_V10_MIGRATION_SQL : EXTENSION_SESSION_V10_NO_VEC_MIGRATION_SQL,
    );
    dbExec(db, "PRAGMA user_version = 10");
    recordMigration(db, 10, "extension + session_memory", now);
  })();
}

function migrateIndexedV10ToV11(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, USER_MCP_V11_MIGRATION_SQL);
    dbExec(db, "PRAGMA user_version = 11");
    recordMigration(db, 11, "user_mcp_connector", now);
  })();
}

function migrateIndexedV11ToV12(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, GRAPH_RELATION_TYPES_V12_SQL);
    dbExec(db, "PRAGMA user_version = 12");
    recordMigration(db, 12, "graph_relation_type filesystem edges", now);
  })();
}

function migrateIndexedV12ToV13(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, CONNECTOR_HEALTH_V13_SQL);
    dbExec(db, "PRAGMA user_version = 13");
    recordMigration(db, 13, "connector health state + history", now);
  })();
}

function migrateIndexedV13ToV14(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, QUERY_LATENCY_V14_SQL);
    dbExec(db, "PRAGMA user_version = 14");
    recordMigration(db, 14, "query_latency_log + slow_query_log", now);
  })();
}

function migrateIndexedV14ToV15(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, CONNECTOR_REMOVE_INTENT_V15_SQL);
    dbExec(db, "PRAGMA user_version = 15");
    recordMigration(db, 15, "connector_remove_intent (crash-safe removal WAL)", now);
  })();
}

function llmModelsSyncStateHasContextWindowColumn(db: Database): boolean {
  const cols = db.query("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "context_window_tokens");
}

function migrateIndexedV15ToV16(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, LLM_MODELS_V16_SQL);
    if (!llmModelsSyncStateHasContextWindowColumn(db)) {
      dbExec(db, LLM_CONTEXT_WINDOW_V16_ALTER_SQL.trim());
    }
    dbExec(db, "PRAGMA user_version = 16");
    recordMigration(db, 16, "llm_models table + sync_state.context_window_tokens", now);
  })();
}

function migrateIndexedV16ToV17(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, SUB_TASK_RESULTS_V17_SQL);
    dbExec(db, "PRAGMA user_version = 17");
    recordMigration(db, 17, "sub_task_results (multi-agent sub-task persistence)", now);
  })();
}

function backfillAuditChain(db: Database): void {
  const rows = db
    .query(
      `SELECT id, action_type, hitl_status, action_json, timestamp FROM audit_log ORDER BY id ASC`,
    )
    .all() as Array<{
    id: number;
    action_type: string;
    hitl_status: string;
    action_json: string;
    timestamp: number;
  }>;
  let prev = "0".repeat(64);
  const update = db.prepare(`UPDATE audit_log SET row_hash = ?, prev_hash = ? WHERE id = ?`);
  for (const r of rows) {
    const row = computeAuditRowHash({
      prevHash: prev,
      actionType: r.action_type,
      hitlStatus: r.hitl_status,
      actionJson: r.action_json,
      timestamp: r.timestamp,
    });
    dbStmtRun(update, row, prev, r.id);
    prev = row;
  }
}

function migrateIndexedV17ToV18(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, AUDIT_CHAIN_V18_SCHEMA_SQL);
    backfillAuditChain(db);
    dbExec(db, "PRAGMA user_version = 18");
    recordMigration(db, 18, "audit_log BLAKE3 chain (row_hash + prev_hash) + _meta", now);
  })();
}

function migrateIndexedV18ToV19(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, LAN_PEERS_V19_SQL);
    dbExec(db, "PRAGMA user_version = 19");
    recordMigration(db, 19, "lan_peers (LAN remote-access peer registry)", now);
  })();
}

function migrateIndexedV19ToV20(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, LLM_TASK_DEFAULTS_V20_SQL);
    dbExec(db, "PRAGMA user_version = 20");
    recordMigration(db, 20, "llm_task_defaults (per-task-type LLM model defaults)", now);
  })();
}

function migrateIndexedV20ToV21(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, CONNECTOR_DEPTH_V21_SQL);
    dbExec(db, "PRAGMA user_version = 21");
    recordMigration(db, 21, "sync_state.depth (per-connector reindex depth)", now);
  })();
}

function migrateIndexedV21ToV22(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, WATCHER_GRAPH_V22_SQL);
    dbExec(db, "PRAGMA user_version = 22");
    recordMigration(db, 22, "watcher.graph_predicate_json (graph-aware conditions)", now);
  })();
}

function migrateIndexedV22ToV23(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, WORKFLOW_RUN_COLUMNS_V23_SQL);
    dbExec(db, "PRAGMA user_version = 23");
    recordMigration(
      db,
      23,
      "workflow_run.dry_run + workflow_run.params_override_json (WS5-D Polish)",
      now,
    );
  })();
}

function migrateIndexedV23ToV24(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, AUDIT_SESSION_V24_SCHEMA_SQL);
    dbExec(db, "PRAGMA user_version = 24");
    recordMigration(db, 24, "audit_log.session_id (transcript rehydration support)", now);
  })();
}

function migrateIndexedV24ToV25(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, API_ENDPOINT_V25_SCHEMA_SQL);
    dbExec(db, "PRAGMA user_version = 25");
    recordMigration(db, 25, "api_endpoint shadow table (Wave A PR 1)", now);
  })();
}

function migrateIndexedV25ToV26(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, OBSIDIAN_NOTES_V26_SCHEMA_SQL);
    dbExec(db, OBSIDIAN_NOTES_V26_SEED_SQL);
    dbExec(db, "PRAGMA user_version = 26");
    recordMigration(db, 26, "obsidian_notes shadow table (Wave A PR 2)", now);
  })();
}

function migrateIndexedV26ToV27(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, PR_COMMIT_RELATION_V27_SEED_SQL);
    dbExec(db, "PRAGMA user_version = 27");
    recordMigration(db, 27, "merged_as graph_relation_type (DORA Lead Time, T4 PR 2)", now);
  })();
}

function migrateIndexedV27ToV28(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, DEPLOYMENT_V28_SCHEMA_SQL);
    dbExec(db, "PRAGMA user_version = 28");
    recordMigration(db, 28, "deployment_items shadow table (T4 PR 3b)", now);
  })();
}

function migrateIndexedV28ToV29(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, TOOL_CALL_LOG_V29_SCHEMA_SQL);
    dbExec(db, "PRAGMA user_version = 29");
    recordMigration(db, 29, "tool_call_log audit table (T6 PR 2)", now);
  })();
}

function migrateIndexedV29ToV30(db: Database, now: number): void {
  const hasVec = vecTableExists(db);
  const sql = hasVec ? VEC_ITEMS_1536_V30_SCHEMA_SQL : VEC_ITEMS_1536_V30_NO_VEC_SQL;
  db.transaction(() => {
    // Bun's bun:sqlite on macOS throws "SQL string mustn't be blank" for an
    // empty `db.exec("")`; Windows/Linux tolerate it. The no-vec fallback is
    // intentionally empty (records the migration row only).
    if (sql.trim().length > 0) {
      dbExec(db, sql);
    }
    dbExec(db, "PRAGMA user_version = 30");
    recordMigration(
      db,
      30,
      hasVec
        ? "vec_items_1536 + dim-aware delete triggers (T6 PR 3)"
        : "vec_items_1536 (sqlite-vec unavailable, T6 PR 3)",
      now,
    );
  })();
}

function migrateIndexedV30ToV31(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, V31_EXTENSION_DEPENDENCY_SQL);
    dbExec(db, "PRAGMA user_version = 31");
    recordMigration(db, 31, "extension_dependency table + reverse-dep index (T2 PR 4)", now);
  })();
}

const INDEXED_SCHEMA_STEPS: readonly IndexedSchemaStep[] = [
  { fromVersion: 0, toVersion: 1, apply: migrateIndexedV0ToV1 },
  { fromVersion: 1, toVersion: 2, apply: migrateIndexedV1ToV2 },
  { fromVersion: 2, toVersion: 3, apply: migrateIndexedV2ToV3 },
  { fromVersion: 3, toVersion: 4, apply: migrateIndexedV3ToV4 },
  { fromVersion: 4, toVersion: 5, apply: migrateIndexedV4ToV5 },
  { fromVersion: 5, toVersion: 6, apply: migrateIndexedV5ToV6 },
  { fromVersion: 6, toVersion: 7, apply: migrateIndexedV6ToV7 },
  { fromVersion: 7, toVersion: 8, apply: migrateIndexedV7ToV8 },
  { fromVersion: 8, toVersion: 9, apply: migrateIndexedV8ToV9 },
  { fromVersion: 9, toVersion: 10, apply: migrateIndexedV9ToV10 },
  { fromVersion: 10, toVersion: 11, apply: migrateIndexedV10ToV11 },
  { fromVersion: 11, toVersion: 12, apply: migrateIndexedV11ToV12 },
  { fromVersion: 12, toVersion: 13, apply: migrateIndexedV12ToV13 },
  { fromVersion: 13, toVersion: 14, apply: migrateIndexedV13ToV14 },
  { fromVersion: 14, toVersion: 15, apply: migrateIndexedV14ToV15 },
  { fromVersion: 15, toVersion: 16, apply: migrateIndexedV15ToV16 },
  { fromVersion: 16, toVersion: 17, apply: migrateIndexedV16ToV17 },
  { fromVersion: 17, toVersion: 18, apply: migrateIndexedV17ToV18 },
  { fromVersion: 18, toVersion: 19, apply: migrateIndexedV18ToV19 },
  { fromVersion: 19, toVersion: 20, apply: migrateIndexedV19ToV20 },
  { fromVersion: 20, toVersion: 21, apply: migrateIndexedV20ToV21 },
  { fromVersion: 21, toVersion: 22, apply: migrateIndexedV21ToV22 },
  { fromVersion: 22, toVersion: 23, apply: migrateIndexedV22ToV23 },
  { fromVersion: 23, toVersion: 24, apply: migrateIndexedV23ToV24 },
  { fromVersion: 24, toVersion: 25, apply: migrateIndexedV24ToV25 },
  { fromVersion: 25, toVersion: 26, apply: migrateIndexedV25ToV26 },
  { fromVersion: 26, toVersion: 27, apply: migrateIndexedV26ToV27 },
  { fromVersion: 27, toVersion: 28, apply: migrateIndexedV27ToV28 },
  { fromVersion: 28, toVersion: 29, apply: migrateIndexedV28ToV29 },
  { fromVersion: 29, toVersion: 30, apply: migrateIndexedV29ToV30 },
  { fromVersion: 30, toVersion: 31, apply: migrateIndexedV30ToV31 },
];

const BACKFILL_LABELS: readonly string[] = [
  "initial filesystem schema (backfilled)",
  "scheduler_state + sync_telemetry (backfilled)",
  "unified item + item_fts + person (backfilled)",
  "person.linked (backfilled)",
  "person extra handles (backfilled)",
  "embedding_chunk + vec_items_384 (backfilled)",
  "graph_entity + graph_relation (backfilled)",
  "watcher + watcher_event (backfilled)",
  "workflow + workflow_run + workflow_run_step (backfilled)",
  "extension + session_memory (backfilled)",
  "user_mcp_connector (backfilled)",
  "graph_relation_type filesystem edges (backfilled)",
  "connector health state + history (backfilled)",
  "query_latency_log + slow_query_log (backfilled)",
  "connector_remove_intent (backfilled)",
  "llm_models table + sync_state.context_window_tokens (backfilled)",
  "sub_task_results (backfilled)",
  "audit_log BLAKE3 chain + _meta (backfilled)",
  "lan_peers (LAN remote-access peer registry) (backfilled)",
  "llm_task_defaults (per-task-type LLM model defaults) (backfilled)",
  "sync_state.depth (per-connector reindex depth) (backfilled)",
  "watcher.graph_predicate_json (graph-aware conditions) (backfilled)",
  "workflow_run.dry_run + workflow_run.params_override_json (WS5-D Polish) (backfilled)",
  "audit_log.session_id (transcript rehydration support) (backfilled)",
  "api_endpoint shadow table (Wave A PR 1) (backfilled)",
  "obsidian_notes shadow table (Wave A PR 2) (backfilled)",
  "merged_as graph_relation_type (DORA Lead Time, T4 PR 2) (backfilled)",
  "deployment_items shadow table (T4 PR 3b) (backfilled)",
  "tool_call_log audit table (T6 PR 2) (backfilled)",
  "vec_items_1536 + dim-aware delete triggers (T6 PR 3) (backfilled)",
  "extension_dependency table + reverse-dep index (T2 PR 4) (backfilled)",
];

/**
 * Backfill the ledger on existing databases that already reached `user_version` before the ledger existed.
 */
function backfillMigrationsLedger(db: Database): void {
  const uv = readIndexedUserVersion(db);
  if (uv < 1) {
    return;
  }
  const row = db.query(`SELECT COUNT(*) as c FROM _schema_migrations`).get() as
    | { c: number }
    | undefined;
  const c = row?.c ?? 0;
  if (c > 0) {
    return;
  }
  const now = Date.now();
  db.transaction(() => {
    for (let v = 1; v <= uv; v++) {
      const label = BACKFILL_LABELS[v - 1];
      if (label === undefined) {
        throw new Error(
          `Backfill migration label missing for schema v${String(v)} (extend BACKFILL_LABELS in runner.ts)`,
        );
      }
      recordMigration(db, v, label, now);
    }
  })();
}

// ─── Pre-migration backup ────────────────────────────────────────────────────

export type MigrationBackupOptions = {
  /** Directory where backups are written, e.g. `<dataDir>/backups`. */
  backupDir: string;
  /** Absolute path to the live DB file (must not be `:memory:`). */
  dbPath: string;
};

/**
 * Thrown when a migration fails mid-run. The pre-migration backup path is
 * included in the message so the Gateway startup handler can print a clear,
 * actionable recovery message before exiting.
 */
export class MigrationRollbackError extends Error {
  readonly migrationVersion: number;
  readonly backupPath: string | null;
  override readonly cause: unknown;

  constructor(version: number, backupPath: string | null, cause: unknown) {
    const hint =
      backupPath === null
        ? " No backup was available (in-memory or missing DB path)."
        : ` A pre-migration backup was saved to: ${backupPath}`;
    super(`Migration v${String(version)} failed and was rolled back.${hint}`);
    this.name = "MigrationRollbackError";
    this.migrationVersion = version;
    this.backupPath = backupPath;
    this.cause = cause;
  }
}

/**
 * Create a gzip-compressed backup of `dbPath` before running migration `version`.
 * Uses `VACUUM INTO` (SQLite 3.27+) so the backup is always clean regardless of
 * WAL state — no need to close the database first.
 *
 * Returns the path of the written `.db.gz` file.
 * Throws if the backup cannot be written (caller aborts the migration).
 */
function writePreMigrationBackup(
  db: Database,
  version: number,
  opts: MigrationBackupOptions,
): string {
  mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });

  const timestamp = Date.now();
  const uniq = randomUUID();
  const tmpPath = join(
    opts.backupDir,
    `pre-migration-${String(version)}-${String(timestamp)}-${uniq}.db`,
  );
  const gzPath = `${tmpPath}.gz`;
  const gzPartial = `${tmpPath}.${uniq}.gz.partial`;

  // VACUUM INTO creates a defragmented, WAL-checkpointed copy without locking
  // the source for longer than a read transaction.
  dbRun(db, `VACUUM INTO ?`, [tmpPath]);
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort */
  }

  // readFileSync / Bun.gzipSync / open+writeSync are all synchronous —
  // safe to call from the migration runner without async plumbing.
  const raw = readFileSync(tmpPath);
  const compressed = Bun.gzipSync(raw);
  const fd = openSync(gzPartial, "wx", 0o600);
  try {
    writeSync(fd, compressed);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(gzPartial, gzPath);
  } catch {
    rmSync(gzPath, { force: true });
    renameSync(gzPartial, gzPath);
  }

  // Remove the uncompressed temp copy
  try {
    rmSync(tmpPath);
  } catch {
    /* non-fatal */
  }

  return gzPath;
}

/**
 * Remove backup files older than `maxAgeDays` from `backupDir`.
 * Called at the end of a fully successful migration run.
 */
function pruneOldBackups(backupDir: string, maxAgeDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return; // directory doesn't exist yet — nothing to prune
  }
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.endsWith(".db.gz")) {
      continue;
    }
    const fullPath = join(backupDir, name);
    try {
      const st = statSync(fullPath);
      if (st.mtimeMs < cutoffMs) {
        rmSync(fullPath);
      }
    } catch {
      /* ignore stat/rm failures — best-effort pruning */
    }
  }
}

function applyIndexedSchemaStep(
  db: Database,
  step: IndexedSchemaStep,
  currentVersion: number,
  targetVersion: number,
  backupOptions: MigrationBackupOptions | undefined,
  now: number,
): number | null {
  if (currentVersion !== step.fromVersion || targetVersion < step.toVersion) {
    return null;
  }
  let backupPath: string | null = null;

  if (backupOptions !== undefined) {
    // Abort the entire run if the backup cannot be written.
    backupPath = writePreMigrationBackup(db, step.toVersion, backupOptions);
  }

  try {
    step.apply(db, now);
  } catch (err) {
    // Each migration runs inside its own transaction — SQLite has already
    // rolled it back. Wrap and re-throw with recovery information.
    throw new MigrationRollbackError(step.toVersion, backupPath, err);
  }

  return step.toVersion;
}

// ─── Public runner ────────────────────────────────────────────────────────────

/**
 * Formal migration runner (Q2 §1.5). `PRAGMA user_version` remains the source of truth for stepping;
 * `_schema_migrations` is an append-only audit log.
 *
 * When `backupOptions` is provided, a gzip-compressed backup of the DB is
 * written before each migration step. On failure the migration transaction is
 * rolled back automatically by SQLite; the backup is available for manual
 * recovery and its path is included in the thrown `MigrationRollbackError`.
 */
export function runIndexedSchemaMigrations(
  db: Database,
  targetVersion: number,
  backupOptions?: MigrationBackupOptions,
): void {
  dbExec(db, MIGRATIONS_LEDGER_SQL);
  backfillMigrationsLedger(db);

  let ver = readIndexedUserVersion(db);
  if (ver >= targetVersion) {
    return;
  }

  const now = Date.now();
  let anyStepRan = false;

  for (const step of INDEXED_SCHEMA_STEPS) {
    const nextVer = applyIndexedSchemaStep(db, step, ver, targetVersion, backupOptions, now);
    if (nextVer !== null) {
      ver = nextVer;
      anyStepRan = true;
    }
  }

  if (ver !== targetVersion) {
    throw new Error(
      `Unsupported local index schema version: ${String(ver)} (expected 0–${String(targetVersion)})`,
    );
  }

  // Prune old backups after a fully successful run (best-effort).
  if (anyStepRan && backupOptions !== undefined) {
    try {
      pruneOldBackups(backupOptions.backupDir, 30);
    } catch {
      /* pruning failure must not prevent successful startup */
    }
  }
}
