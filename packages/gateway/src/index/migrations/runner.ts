import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONNECTOR_REMOVE_INTENT_V15_SQL } from "../../connectors/remove-intent.ts";
import { computeAuditRowHash } from "../../db/audit-chain.ts";
import { vacuumAndGzip } from "../../db/vacuum-gzip.ts";
import { dbExec, dbRun, dbStmtRun } from "../../db/write.ts";
import { canonicalizeUrl } from "../../util/url-canonical.ts";
import { API_ENDPOINT_V25_SCHEMA_SQL } from "../api-endpoint-v25-sql.ts";
import { AUDIT_CHAIN_V18_SCHEMA_SQL } from "../audit-chain-v18-sql.ts";
import { AUDIT_SESSION_V24_SCHEMA_SQL } from "../audit-session-v24-sql.ts";
import { BODY_STORE_V48_SQL, ITEM_FTS_UPDATE_TRIGGER_SQL } from "../body-store-v48-sql.ts";
import { CONNECTOR_DEPTH_V21_SQL } from "../connector-depth-v21-sql.ts";
import { CONNECTOR_HEALTH_V13_SQL } from "../connector-health-v13-sql.ts";
import { DECISIONS_V47_SQL } from "../decisions-v47-sql.ts";
import { DEPLOYMENT_V28_SCHEMA_SQL } from "../deployment-v28-sql.ts";
import { DEPTH_DEFAULT_V49_SQL } from "../depth-default-v49-sql.ts";
import { EGRESS_LEDGER_V44_SQL } from "../egress-ledger-v44-sql.ts";
import {
  EMBEDDING_V6_MIGRATION_SQL,
  EMBEDDING_V6_NO_VEC_MIGRATION_SQL,
} from "../embedding-v6-sql.ts";
import { ENTITY_METADATA_V54_SQL } from "../entity-metadata-v54-sql.ts";
import { V31_EXTENSION_DEPENDENCY_SQL } from "../extension-dependency-v31-sql.ts";
import {
  EXTENSION_SESSION_V10_MIGRATION_SQL,
  EXTENSION_SESSION_V10_NO_VEC_MIGRATION_SQL,
} from "../extension-session-v10-sql.ts";
import { V33_FEDERATION_SQL } from "../federation-v33-sql.ts";
import { GDPR_V37_SQL } from "../gdpr-v37-sql.ts";
import { V32_GIT_BLAME_LINE_SQL } from "../git-blame-line-v32-sql.ts";
import { GLOSSARY_MANUAL_V46_SQL } from "../glossary-manual-v46-sql.ts";
import { GLOSSARY_V45_SQL } from "../glossary-v45-sql.ts";
import { GRAPH_LINEAGE_TYPES_V40_SQL } from "../graph-lineage-types-v40-sql.ts";
import { GRAPH_RELATION_TYPES_V12_SQL } from "../graph-relation-types-v12-sql.ts";
import { GRAPH_V7_MIGRATION_SQL } from "../graph-v7-sql.ts";
import { V34_IDENTITY_SQL } from "../identity-v34-sql.ts";
import { KNOWN_NAMESPACES_V38_SQL } from "../known-namespaces-v38-sql.ts";
import { LAN_PEERS_V19_SQL } from "../lan-peers-v19-sql.ts";
import { LLM_CONTEXT_WINDOW_V16_ALTER_SQL, LLM_MODELS_V16_SQL } from "../llm-models-v16-sql.ts";
import { LLM_TASK_DEFAULTS_V20_SQL } from "../llm-task-defaults-v20-sql.ts";
import {
  OBSIDIAN_NOTES_V26_SCHEMA_SQL,
  OBSIDIAN_NOTES_V26_SEED_SQL,
} from "../obsidian-notes-v26-sql.ts";
import {
  OWNERSHIP_PASS_STATE_V51_SQL,
  OWNERSHIP_RELATION_TYPES_V51_SQL,
  SCHEMA_V50_RESERVED_SQL,
} from "../ownership-v51-sql.ts";
import { PERSON_HANDLES_V5_ALTER_SQL } from "../person-handles-v5-sql.ts";
import { PERSON_LINKED_V4_ALTER_SQL } from "../person-linked-v4-sql.ts";
import { POLICY_V36_SQL } from "../policy-v36-sql.ts";
import { PR_COMMIT_RELATION_V27_SEED_SQL } from "../pr-commit-relation-v27-sql.ts";
import { PREMORTEM_V53_SQL } from "../premortem-v53-sql.ts";
import { QUERY_LATENCY_V14_SQL } from "../query-latency-v14-sql.ts";
import { RESOLVE_KEY_V52_SQL } from "../resolve-key-v52-sql.ts";
import { SCHEDULER_V2_MIGRATION_SQL } from "../scheduler-schema-sql.ts";
import { INITIAL_SCHEMA_SQL } from "../schema-sql.ts";
import { SHARE_INBOX_V43_SQL } from "../share-inbox-v43-sql.ts";
import { SHARE_RECORDS_V41_SQL } from "../share-records-v41-sql.ts";
import { tryLoadSqliteVec } from "../sqlite-vec-load.ts";
import { SUB_TASK_RESULTS_V17_SQL } from "../sub-task-results-v17-sql.ts";
import { V35_TEAM_VAULT_SQL } from "../team-vault-v35-sql.ts";
import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../tool-call-log-v29-sql.ts";
import { TOOL_CALL_PARAMS_V42_SQL } from "../tool-call-params-v42-sql.ts";
import { TRIBAL_CLUSTERS_V39_SQL } from "../tribal-clusters-v39-sql.ts";
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

/**
 * Runs one SQL constant (or a sequence), bumps `PRAGMA user_version` to the
 * target version, and records the step in `_schema_migrations`. All three
 * operations execute in a single `db.transaction` so the migration is atomic.
 *
 * Use this from a `migrateIndexedV*` function when the step's logic doesn't
 * fit the declarative `simpleStep` shape (e.g., needs a conditional probe,
 * a runtime branch on `tryLoadSqliteVec`, or a custom data backfill alongside
 * the schema change). Otherwise, prefer `simpleStep` in `INDEXED_SCHEMA_STEPS`.
 */
function applySchemaStep(
  db: Database,
  version: number,
  description: string,
  sql: string | readonly string[],
  now: number,
): void {
  db.transaction(() => {
    if (typeof sql === "string") {
      dbExec(db, sql);
    } else {
      for (const s of sql) {
        dbExec(db, s);
      }
    }
    dbExec(db, `PRAGMA user_version = ${String(version)}`);
    recordMigration(db, version, description, now);
  })();
}

/**
 * Build a declarative `IndexedSchemaStep` for the common "exec one (or a
 * sequence of) SQL constants" shape. Pass `sql` as `string` for single-statement
 * migrations or `readonly string[]` for two-statement ones (e.g., schema + seed).
 *
 * For migrations that need conditional probes, vec-table branching, or custom
 * data backfills, write a bespoke `migrateIndexedV*ToV*` function and reference
 * it directly in `INDEXED_SCHEMA_STEPS`.
 */
function simpleStep(
  fromVersion: number,
  toVersion: number,
  description: string,
  sql: string | readonly string[],
): IndexedSchemaStep {
  return {
    fromVersion,
    toVersion,
    apply: (db, now) => applySchemaStep(db, toVersion, description, sql, now),
  };
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
  // A statement from db.prepare() must be finalized explicitly: bun:sqlite only
  // auto-releases the db.query() cache, so an unfinalized handle makes a later
  // db.close() a silent no-op and pins the database file open (#969).
  try {
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
  } finally {
    update.finalize();
  }
}

/**
 * Chunk size for the V52 backfill. Bounds MEMORY, not transaction size: the whole step runs inside
 * one `db.transaction` (see `applySchemaStep`), so there is deliberately NO commit per chunk.
 * Committing per chunk would leave `resolve_key` half-populated with `PRAGMA user_version` already
 * advanced — an index that resolves some URLs and not others, invisible until a user asks why one
 * PR resolves and another does not.
 *
 * Exported so the multi-chunk test in runner.test.ts cannot drift from the real value.
 */
export const RESOLVE_KEY_BACKFILL_CHUNK = 5_000;

function backfillResolveKey(db: Database): void {
  const select = db.prepare(
    `SELECT id, url, canonical_url FROM item
     WHERE resolve_key IS NULL AND (url IS NOT NULL OR canonical_url IS NOT NULL)
     ORDER BY id ASC LIMIT ?`,
  );
  const update = db.prepare(`UPDATE item SET resolve_key = ? WHERE id = ?`);
  // Both statements come from db.prepare() and MUST be finalized: bun:sqlite only auto-releases the
  // db.query() cache, so an unfinalized handle makes a later db.close() a silent no-op (#969).
  try {
    for (;;) {
      const rows = select.all(RESOLVE_KEY_BACKFILL_CHUNK) as Array<{
        id: string;
        url: string | null;
        canonical_url: string | null;
      }>;
      if (rows.length === 0) {
        break;
      }
      for (const r of rows) {
        const raw = r.canonical_url ?? r.url;
        // The WHERE clause already excludes both-NULL rows; this narrows the type.
        if (raw === null) {
          continue;
        }
        dbStmtRun(update, canonicalizeUrl(raw), r.id);
      }
      // Deliberately NO OFFSET: the WHERE clause filters on `resolve_key IS NULL`, and this loop
      // WRITES that column, so the candidate set shrinks by exactly the rows just updated. The next
      // unprocessed rows are therefore always back at the front of an unfiltered LIMIT-only query.
      // An OFFSET here would compound two shrinks — the set shrinking under it AND the offset
      // advancing on top of that — and silently skip roughly half the rows past the first chunk
      // boundary (a real defect this migration shipped with once; see runner.test.ts's
      // "multi-chunk" test for the failure trace).
      if (rows.length < RESOLVE_KEY_BACKFILL_CHUNK) {
        break;
      }
    }
  } finally {
    select.finalize();
    update.finalize();
  }
}

function migrateIndexedV51ToV52(db: Database, now: number): void {
  db.transaction(() => {
    for (const sql of RESOLVE_KEY_V52_SQL) {
      dbExec(db, sql);
    }
    // The V48 `item_fts_update` trigger has no `OF <column>` list, so every UPDATE on `item` —
    // including this backfill's `resolve_key`-only writes — fires a full FTS5 delete+reinsert of
    // `title`/`body`. `resolve_key` is not an FTS column, so drop the trigger for the duration of
    // the backfill and recreate it VERBATIM afterwards from `ITEM_FTS_UPDATE_TRIGGER_SQL` — the
    // SAME string constant `body-store-v48-sql.ts` uses to create it — so the two can never drift.
    // Both the drop and the recreate live inside this transaction: a mid-backfill throw rolls back
    // the drop too, so a failed migration can never leave the database without its FTS update
    // trigger.
    dbExec(db, "DROP TRIGGER item_fts_update");
    backfillResolveKey(db);
    dbExec(db, ITEM_FTS_UPDATE_TRIGGER_SQL);
    dbExec(db, "PRAGMA user_version = 52");
    recordMigration(db, 52, "item.resolve_key + idx_item_resolve_key (resolve-by-URL v52)", now);
  })();
}

function migrateIndexedV17ToV18(db: Database, now: number): void {
  db.transaction(() => {
    dbExec(db, AUDIT_CHAIN_V18_SCHEMA_SQL);
    backfillAuditChain(db);
    dbExec(db, "PRAGMA user_version = 18");
    recordMigration(db, 18, "audit_log BLAKE3 chain (row_hash + prev_hash) + _meta", now);
  })();
}

function migrateIndexedV29ToV30(db: Database, now: number): void {
  const hasVec = vecTableExists(db);
  const sql = hasVec ? VEC_ITEMS_1536_V30_SCHEMA_SQL : VEC_ITEMS_1536_V30_NO_VEC_SQL;
  db.transaction(() => {
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

const INDEXED_SCHEMA_STEPS: readonly IndexedSchemaStep[] = [
  simpleStep(0, 1, "initial filesystem schema", INITIAL_SCHEMA_SQL),
  simpleStep(1, 2, "scheduler_state + sync_telemetry", SCHEDULER_V2_MIGRATION_SQL),
  simpleStep(2, 3, "unified item + item_fts + person", [
    UNIFIED_ITEM_V3_SCHEMA_SQL,
    UNIFIED_ITEM_V3_MIGRATE_FROM_LEGACY_SQL,
  ]),
  { fromVersion: 3, toVersion: 4, apply: migrateIndexedV3ToV4 },
  { fromVersion: 4, toVersion: 5, apply: migrateIndexedV4ToV5 },
  { fromVersion: 5, toVersion: 6, apply: migrateIndexedV5ToV6 },
  simpleStep(6, 7, "graph_entity + graph_relation", GRAPH_V7_MIGRATION_SQL),
  simpleStep(7, 8, "watcher + watcher_event", WATCHER_V8_MIGRATION_SQL),
  simpleStep(8, 9, "workflow tables", WORKFLOW_V9_MIGRATION_SQL),
  { fromVersion: 9, toVersion: 10, apply: migrateIndexedV9ToV10 },
  simpleStep(10, 11, "user_mcp_connector", USER_MCP_V11_MIGRATION_SQL),
  simpleStep(11, 12, "graph_relation_type filesystem edges", GRAPH_RELATION_TYPES_V12_SQL),
  simpleStep(12, 13, "connector health state + history", CONNECTOR_HEALTH_V13_SQL),
  simpleStep(13, 14, "query_latency_log + slow_query_log", QUERY_LATENCY_V14_SQL),
  simpleStep(
    14,
    15,
    "connector_remove_intent (crash-safe removal WAL)",
    CONNECTOR_REMOVE_INTENT_V15_SQL,
  ),
  { fromVersion: 15, toVersion: 16, apply: migrateIndexedV15ToV16 },
  simpleStep(
    16,
    17,
    "sub_task_results (multi-agent sub-task persistence)",
    SUB_TASK_RESULTS_V17_SQL,
  ),
  { fromVersion: 17, toVersion: 18, apply: migrateIndexedV17ToV18 },
  simpleStep(18, 19, "lan_peers (LAN remote-access peer registry)", LAN_PEERS_V19_SQL),
  simpleStep(
    19,
    20,
    "llm_task_defaults (per-task-type LLM model defaults)",
    LLM_TASK_DEFAULTS_V20_SQL,
  ),
  simpleStep(20, 21, "sync_state.depth (per-connector reindex depth)", CONNECTOR_DEPTH_V21_SQL),
  simpleStep(
    21,
    22,
    "watcher.graph_predicate_json (graph-aware conditions)",
    WATCHER_GRAPH_V22_SQL,
  ),
  simpleStep(
    22,
    23,
    "workflow_run.dry_run + workflow_run.params_override_json (WS5-D Polish)",
    WORKFLOW_RUN_COLUMNS_V23_SQL,
  ),
  simpleStep(
    23,
    24,
    "audit_log.session_id (transcript rehydration support)",
    AUDIT_SESSION_V24_SCHEMA_SQL,
  ),
  simpleStep(24, 25, "api_endpoint shadow table (Wave A PR 1)", API_ENDPOINT_V25_SCHEMA_SQL),
  simpleStep(25, 26, "obsidian_notes shadow table (Wave A PR 2)", [
    OBSIDIAN_NOTES_V26_SCHEMA_SQL,
    OBSIDIAN_NOTES_V26_SEED_SQL,
  ]),
  simpleStep(
    26,
    27,
    "merged_as graph_relation_type (DORA Lead Time, T4 PR 2)",
    PR_COMMIT_RELATION_V27_SEED_SQL,
  ),
  simpleStep(27, 28, "deployment_items shadow table (T4 PR 3b)", DEPLOYMENT_V28_SCHEMA_SQL),
  simpleStep(28, 29, "tool_call_log audit table (T6 PR 2)", TOOL_CALL_LOG_V29_SCHEMA_SQL),
  { fromVersion: 29, toVersion: 30, apply: migrateIndexedV29ToV30 },
  simpleStep(
    30,
    31,
    "extension_dependency table + reverse-dep index (T2 PR 4)",
    V31_EXTENSION_DEPENDENCY_SQL,
  ),
  simpleStep(
    31,
    32,
    "git_blame_line table (security scan v2 blame attribution)",
    V32_GIT_BLAME_LINE_SQL,
  ),
  simpleStep(
    32,
    33,
    "federation namespaces/filters/grants + audit_log.federation_json (federation v33)",
    V33_FEDERATION_SQL,
  ),
  simpleStep(
    33,
    34,
    "identity_session/scim_user/identity_binding/oidc_jwks_cache (identity v34)",
    V34_IDENTITY_SQL,
  ),
  simpleStep(
    34,
    35,
    "team_vault_entries/grants + hitl_delegations (team vault + multi-user/quorum HITL v35)",
    V35_TEAM_VAULT_SQL,
  ),
  simpleStep(35, 36, "org_policy_state + policy_anchor_pin (policy v36)", POLICY_V36_SQL),
  simpleStep(36, 37, "gdpr_purge_job + gdpr_purge_request (gdpr purge ledger v37)", GDPR_V37_SQL),
  simpleStep(37, 38, "federation_known_namespaces asker-side cache", KNOWN_NAMESPACES_V38_SQL),
  simpleStep(
    38,
    39,
    "tribal_clusters (tribal-knowledge cluster ledger v39)",
    TRIBAL_CLUSTERS_V39_SQL,
  ),
  simpleStep(
    39,
    40,
    "graph lineage relation types (data-warehouse/BI lineage v40)",
    GRAPH_LINEAGE_TYPES_V40_SQL,
  ),
  simpleStep(40, 41, "share_records (share & virality ledger v41)", SHARE_RECORDS_V41_SQL),
  simpleStep(41, 42, "tool_call_log.params_json (recipe params v42)", TOOL_CALL_PARAMS_V42_SQL),
  simpleStep(42, 43, "share_inbox (sovereign-mesh referral v43)", SHARE_INBOX_V43_SQL),
  simpleStep(43, 44, "egress_ledger (provable-locality primitive v44)", EGRESS_LEDGER_V44_SQL),
  simpleStep(
    44,
    45,
    "glossary_term + glossary_pass_state (implicit-knowledge glossary v45)",
    GLOSSARY_V45_SQL,
  ),
  simpleStep(
    45,
    46,
    "glossary_term.definition_source allows 'manual' (v46)",
    GLOSSARY_MANUAL_V46_SQL,
  ),
  simpleStep(
    46,
    47,
    "decision_record + decision_evidence + decision_pass_state (implicit ADR extractor v47)",
    DECISIONS_V47_SQL,
  ),
  simpleStep(
    47,
    48,
    "item.body + body_complete; item_fts over body (full-body store v48)",
    BODY_STORE_V48_SQL,
  ),
  simpleStep(
    48,
    49,
    "connector depth default summary->full (enforced depth v49)",
    DEPTH_DEFAULT_V49_SQL,
  ),
  // This description PERSISTS into every user's `_schema_migrations` ledger, so it must not
  // carry the retracted "reserved for X" claim — the slot is a permanent no-op (see
  // `SCHEMA_V50_RESERVED_SQL`).
  simpleStep(
    49,
    50,
    "V50 retired no-op (never backfill; a DB at V51 never re-enters this step)",
    SCHEMA_V50_RESERVED_SQL,
  ),
  simpleStep(50, 51, "ownership relation types + ownership_pass_state", [
    OWNERSHIP_RELATION_TYPES_V51_SQL,
    OWNERSHIP_PASS_STATE_V51_SQL,
  ]),
  { fromVersion: 51, toVersion: 52, apply: migrateIndexedV51ToV52 },
  simpleStep(52, 53, "premortem theme extraction tables", PREMORTEM_V53_SQL),
  simpleStep(53, 54, "graph_entity metadata namespacing", ENTITY_METADATA_V54_SQL),
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
  "git_blame_line table (security scan v2 blame attribution) (backfilled)",
  "federation namespaces/filters/grants + audit_log.federation_json (federation v33) (backfilled)",
  "identity_session/scim_user/identity_binding/oidc_jwks_cache (identity v34) (backfilled)",
  "team_vault_entries/grants + hitl_delegations (team vault + multi-user/quorum HITL v35) (backfilled)",
  "org_policy_state + policy_anchor_pin (policy v36) (backfilled)",
  "gdpr_purge_job + gdpr_purge_request (gdpr purge ledger v37) (backfilled)",
  // NOTE: BACKFILL_LABELS intentionally stops at v37. The ledger has existed since v18, so any DB
  // at v38+ already has populated `_schema_migrations` rows and backfill short-circuits before the
  // loop — newer migrations need no backfill label. (runner.test.ts pins the missing-label throw to
  // v38.) Do NOT append a label per new migration or that error branch becomes unreachable.
];

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

export type MigrationBackupOptions = {
  backupDir: string;
  dbPath: string;
};

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

  vacuumAndGzip(db, tmpPath, gzPath);

  return gzPath;
}

// Exported for direct branch testing of the missing-directory catch path (the normal
// migration flow always mkdir's the backup dir before pruning, so it can't reach it).
export function pruneOldBackups(backupDir: string, maxAgeDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return;
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
    backupPath = writePreMigrationBackup(db, step.toVersion, backupOptions);
  }

  try {
    step.apply(db, now);
  } catch (err) {
    throw new MigrationRollbackError(step.toVersion, backupPath, err);
  }

  return step.toVersion;
}

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

  if (anyStepRan && backupOptions !== undefined) {
    try {
      pruneOldBackups(backupOptions.backupDir, 30);
    } catch {
      /* pruning failure must not prevent successful startup */
    }
  }
}
