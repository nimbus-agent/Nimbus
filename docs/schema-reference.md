# Local Database Schema Reference

The SQLite tables that back the local index, audit log, sync state, embeddings, and extension registry. This is **reference material** — extracted from [`architecture.md`](./architecture.md) so the architecture narrative stays focused on the system's shape rather than every column. Read it when you need exact column names, or when authoring a migration (pair with the [`nimbus-db-migrations`](../.claude/commands/nimbus-db-migrations.md) skill).

> **Canonical migration list:** the runner at [`packages/gateway/src/index/migrations/runner.ts`](../packages/gateway/src/index/migrations/runner.ts) holds the authoritative `INDEXED_SCHEMA_STEPS` array — each step pairs a `migrateIndexedV<N>ToV<M>` function with the SQL constants imported from sibling [`packages/gateway/src/index/`](../packages/gateway/src/index/) `*-v<N>-sql.ts` files. The runner wraps each step in a single transaction, writes a pre-migration backup to `<dataDir>/backups/pre-migration-V<N>-<timestamp>.db`, records success in the `_schema_migrations` ledger, and rolls back on a thrown migration. **Latest applied migration: V31** (`extension_dependency` table — Phase 5 T2 PR 4; V30 added `vec_items_1536` for T6 PR 3, V29 added `tool_call_log` for T6 PR 2). Migrations are append-only and forward-only — no `down()` function. See [`.claude/commands/nimbus-db-migrations.md`](../.claude/commands/nimbus-db-migrations.md) for the authoring contract (numbering, batched backfill, FTS5 / vec0 cautions).
>
> The SQL block below is the **shape**, not a snapshot of every column. Phase 6+ tables will land as new migrations and new item types — `service` / `team` / `scorecard` / `dora_metric` (Phase 7), `security_finding` / `posture_finding` / `security_incident` / `sbom_artifact` (Phase 8), `llm_trace` / `ml_model` / `vector_index` / `ai_spend_event` (Phase 9), and the multimodal-understanding / sandbox-execution tables (Phase 14). See [`roadmap.md` § Planned](./roadmap.md#planned) for the phase index.

```sql
-- Core metadata index
-- item_type values: "file" | "email" | "event" | "photo"
--                   "pr" | "issue" | "pipeline_run" | "deployment"
--                   "alert" | "incident" | "infra_resource"
--                   "data_model" | "data_pipeline" | "dashboard" | "log_alarm"  -- Phase 5/6
--                   "ml_model" | "data_quality_test"                             -- Phase 5/6 (pass 2)
--                   "api_endpoint"                                               -- Phase 5 Wave A PR 1 (V25)
--                   "obsidian_note"                                              -- Phase 5 Wave A PR 2 (V26)
-- Phase 7+: "service" | "team" | "scorecard" | "dora_metric" | "feature_flag" | ...
-- Phase 8+: "security_finding" | "posture_finding" | "security_incident" | "sbom_artifact" | ...
-- Phase 9+: "llm_trace" | "prompt_version" | "eval_run" | "vector_index" | "ai_spend_event" | ...
-- Note: "task" is not a currently emitted item_type; use "issue" for Linear/Jira items.
CREATE TABLE indexed_items (
    id          TEXT PRIMARY KEY,   -- "<service>:<native_id>"
    service     TEXT NOT NULL,      -- "google_drive" | "gmail" | "github" | "jenkins" | ...
    item_type   TEXT NOT NULL,
    name        TEXT NOT NULL,
    mime_type   TEXT,
    size_bytes  INTEGER,
    created_at  INTEGER,            -- Unix ms
    modified_at INTEGER,
    url         TEXT,
    parent_id   TEXT,
    sync_token  TEXT,
    raw_meta    TEXT                -- JSON blob: service-specific fields
);

CREATE INDEX idx_items_service_modified ON indexed_items(service, modified_at DESC);
CREATE INDEX idx_items_name ON indexed_items(name COLLATE NOCASE);

-- Full-text search (FTS5)
CREATE VIRTUAL TABLE items_fts USING fts5(
    name, raw_meta,
    content=indexed_items, content_rowid=rowid
);

-- Vector search (sqlite-vec)
-- Dimension-qualified to support multi-model coexistence side by side.
-- Phase 3: vec_items_384 (float[384], all-MiniLM-L6-v2).
CREATE VIRTUAL TABLE vec_items_384 USING vec0(
    embedding FLOAT[384]
);
-- Phase 5 T6 PR 3 (V30): vec_items_1536 (float[1536], text-embedding-3-small).
-- Per-(service, type) routing in embedding/routing.ts:PROSE_HEAVY_TYPES
-- dispatches prose-heavy items to OpenAI in hybrid mode; everything else
-- stays on the 384-dim local table. Dim-aware delete triggers
-- (embedding_chunk_ad_delete_vec384 / _vec1536) fan deletes to the matching
-- vec table only.
CREATE VIRTUAL TABLE vec_items_1536 USING vec0(
    embedding FLOAT[1536]
);
-- embedding_chunk table (metadata per chunk) references vec_items_*.rowid
-- and tracks model + dims to support multi-model coexistence.

-- Full audit trail — append-only; written before each action executes.
-- BLAKE3-chained for tamper evidence (row_hash / prev_hash added by V18);
-- session_id added by V24. Verified by `nimbus audit verify`.
CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    timestamp   INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    connector   TEXT NOT NULL,
    payload     TEXT,               -- JSON
    hitl_status TEXT NOT NULL,      -- "approved" | "rejected" | "not_required"
    outcome     TEXT NOT NULL,      -- "success" | "error"
    row_hash    TEXT NOT NULL,      -- BLAKE3(prev_hash || canonical_row_bytes) — V18
    prev_hash   TEXT                -- chain link to previous row — V18
);

-- Sync state per connector (Phase 3.5: extended health model)
CREATE TABLE sync_state (
    connector_id    TEXT PRIMARY KEY,
    last_sync_at    INTEGER,
    next_sync_token TEXT,
    -- Phase 3.5 health columns
    health_state    TEXT NOT NULL DEFAULT 'healthy'
                    CHECK(health_state IN
                      ('healthy','degraded','error','rate_limited','unauthenticated','paused')),
    retry_after     INTEGER,        -- unix ms; non-null when health_state = 'rate_limited'
    backoff_until   INTEGER,        -- unix ms; non-null when in exponential backoff
    backoff_attempt INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,           -- last error message, truncated to 512 chars
    -- Phase 4 WS1: LLM context window discovered during model sync
    context_window_tokens INTEGER
);

-- Connector health transition history (Phase 3.5) — last 7 days retained
CREATE TABLE connector_health_history (
    id           INTEGER PRIMARY KEY,
    connector_id TEXT NOT NULL,
    from_state   TEXT,
    to_state     TEXT NOT NULL,
    reason       TEXT,
    occurred_at  INTEGER NOT NULL   -- unix ms
);
CREATE INDEX idx_chh_connector_occurred
    ON connector_health_history(connector_id, occurred_at DESC);

-- OpenAPI / AsyncAPI endpoint shadow (Phase 5 Wave A PR 1) — V25 migration.
-- One row per indexed endpoint, keyed by `item.id`. The `item.service`
-- column is always "openapi" for these rows; `service_name` here is the
-- inferred service that owns the endpoint (from the spec's enclosing
-- directory, info.title slug, or sha8 fallback).
CREATE TABLE api_endpoint (
    id            TEXT PRIMARY KEY,
    service_name  TEXT NOT NULL,
    path          TEXT NOT NULL,
    method        TEXT NOT NULL,        -- "GET"/"POST"/... or "PUBLISH"/"SUBSCRIBE" for AsyncAPI
    operation_id  TEXT,
    tags_json     TEXT NOT NULL DEFAULT '[]',
    deprecated    INTEGER NOT NULL DEFAULT 0,
    spec_file     TEXT NOT NULL,        -- absolute path
    spec_version  TEXT NOT NULL,        -- "openapi-3.1.0" / "swagger-2.0" / "asyncapi-2.6.0"
    last_modified INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    CHECK (deprecated IN (0, 1))
);
CREATE INDEX idx_api_endpoint_service_path_method
    ON api_endpoint(service_name, path, method);
CREATE INDEX idx_api_endpoint_spec_file
    ON api_endpoint(spec_file);

-- Obsidian vault note shadow (Phase 5 Wave A PR 2) — V26 migration.
-- One row per indexed Markdown note, keyed by `item.id`. Body content
-- lives in the standard `item` / `item_fts` tables (via upsertIndexedItem);
-- this shadow table holds structured metadata only.
--
-- Caveat: `vault_id = sha256(absoluteVaultRootPath).slice(0, 12)`. Moving
-- a vault re-issues every note id at the new path (delete-then-upsert).
-- Any user-attached metadata (manual pins, manual graph edges in the UI)
-- is orphaned. A future `nimbus connector obsidian remap-vault` migration
-- command may bridge old and new IDs; out of scope for PR 2.
CREATE TABLE obsidian_notes (
    id                TEXT PRIMARY KEY,
    vault_id          TEXT NOT NULL,
    vault_name        TEXT NOT NULL,
    path              TEXT NOT NULL,        -- relative to vault root, forward-slashed
    title             TEXT NOT NULL,
    frontmatter_json  TEXT NOT NULL DEFAULT '{}',
    tags_json         TEXT NOT NULL DEFAULT '[]',
    wikilinks_json    TEXT NOT NULL DEFAULT '[]',
    daily_note_date   TEXT,                 -- ISO date or NULL
    last_modified     INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
);
CREATE INDEX idx_obsidian_notes_vault_path
    ON obsidian_notes(vault_id, path);
CREATE INDEX idx_obsidian_notes_daily_note_date
    ON obsidian_notes(daily_note_date)
    WHERE daily_note_date IS NOT NULL;

-- Query latency log (Phase 3.5) — batch-written from in-memory ring buffer
CREATE TABLE query_latency_log (
    id          INTEGER PRIMARY KEY,
    latency_ms  REAL NOT NULL,
    query_type  TEXT NOT NULL,   -- 'fts' | 'vector' | 'hybrid' | 'sql'
    recorded_at INTEGER NOT NULL
);

-- Slow query log (Phase 3.5) — queries exceeding [db.slow_query_threshold_ms] (default 500ms)
CREATE TABLE slow_query_log (
    id          INTEGER PRIMARY KEY,
    query_text  TEXT,
    latency_ms  REAL NOT NULL,
    query_type  TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
);

-- Local LLM model registry (Phase 4 WS1 — V16 migration)
CREATE TABLE llm_models (
    id               TEXT PRIMARY KEY,   -- "<provider>:<model_name>"
    provider         TEXT NOT NULL       CHECK(provider IN ('ollama','llamacpp','remote')),
    model_name       TEXT NOT NULL,
    parameter_count  TEXT,               -- "3B" | "7B" | "13B" etc.
    context_window   INTEGER,
    quantization     TEXT,               -- "Q4_K_M" etc.
    vram_estimate_mb INTEGER,
    last_error       TEXT,
    bench_tps        REAL,               -- tokens/sec from last benchmark
    last_seen_at     INTEGER NOT NULL    -- unix ms
);

-- Multi-agent sub-task results (Phase 4 WS1 — V17 migration)
CREATE TABLE sub_task_results (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    parent_id    TEXT,                  -- references sub_task_results(id); null for root
    task_index   INTEGER NOT NULL,
    task_type    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','running','done','rejected','error')),
    result_json  TEXT,
    error_text   TEXT,
    model_used   TEXT,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    started_at   INTEGER,               -- unix ms
    completed_at INTEGER,               -- unix ms
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_str_session ON sub_task_results(session_id, task_index);

-- Workflow dry run and params override (Phase 4 WS5-D — V23 migration)
ALTER TABLE workflow_run ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_run ADD COLUMN params_override_json TEXT;

-- Audit session rehydration (Phase 4 WS6 — V24 migration)
ALTER TABLE audit_log ADD COLUMN session_id TEXT;
CREATE INDEX idx_audit_log_session_id ON audit_log(session_id);

-- Tool-call audit log (Phase 5 T6 PR 2 — V29 migration)
-- Forensic complement to invariant I11 (the <tool_output> envelope on the
-- LLM-facing path). Written at both wrapToolOutput sites (engine/agent.ts
-- wrapToolForLlm + connectors/lazy-mesh/mesh.ts listTools) via writeToolCallLog
-- in db/tool-call-log.ts (best-effort — never breaks the LLM-facing path).
-- Envelopes >64 KiB are truncated with a "...[truncated, N bytes total]" marker.
-- Read surface: audit.toolCalls IPC (read-only, IPC-only — NOT LAN-callable per
-- I5, NOT in Tauri ALLOWED_METHODS per I7, NOT exposed via the HTTP API).
CREATE TABLE tool_call_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT,                                       -- NULL when no agentRequestContext.run in scope
    tool_id         TEXT NOT NULL,                              -- "github_repo_pr_list" | "searchLocalIndex" | ...
    service         TEXT NOT NULL,                              -- "github" | "filesystem" | "local" | ...
    called_at       INTEGER NOT NULL,                           -- unix ms when the wrapped tool was invoked
    duration_ms     INTEGER NOT NULL,                           -- wall-clock ms from invocation to envelope emission
    result_envelope TEXT NOT NULL,                              -- full <tool_output>...</tool_output> (capped 64 KiB)
    status          TEXT NOT NULL CHECK(status IN ('ok','error'))
);
CREATE INDEX idx_tool_call_log_session   ON tool_call_log(session_id);
CREATE INDEX idx_tool_call_log_tool_time ON tool_call_log(tool_id, called_at);
CREATE INDEX idx_tool_call_log_called_at ON tool_call_log(called_at);

-- Extension dependency graph (Phase 5 T2 PR 4 — V31 migration)
-- One row per (extension, dependency) edge from the manifest `dependsOn` field.
-- The reverse index powers the `nimbus extension remove` reverse-dep guard and
-- `extension.info --deps`. Solved by the backtracking DFS in dependency-graph.ts.
CREATE TABLE extension_dependency (
    extension_id  TEXT    NOT NULL,
    depends_on_id TEXT    NOT NULL,
    range         TEXT    NOT NULL,        -- semver range constraint
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (extension_id, depends_on_id)
);
CREATE INDEX idx_extension_dependency_reverse
    ON extension_dependency(depends_on_id);

-- Extension registry (mirrors the extensions SQLite schema in Subsystem 4)
CREATE TABLE extensions (
    id              TEXT PRIMARY KEY,   -- "com.example.notion"
    display_name    TEXT NOT NULL,
    version         TEXT NOT NULL,
    package_path    TEXT NOT NULL,
    entrypoint      TEXT NOT NULL,
    permissions     TEXT NOT NULL,      -- JSON array: ["read","write"]
    hitl_required   TEXT NOT NULL,      -- JSON array: ["write"]
    manifest_hash   TEXT NOT NULL,      -- SHA-256 of nimbus.extension.json
    installed_at    INTEGER NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_sync_at    INTEGER,
    last_error      TEXT,
    registry_source TEXT               -- "npm" | "local" | "registry.nimbus-agent.dev"
);
```

**SQLite write boundary.** Every production write goes through `dbRun` / `dbExec` / `dbStmtRun` in `packages/gateway/src/db/write.ts` (invariant `I14`). The wrappers translate `SQLITE_FULL` into a typed `DiskFullError`; the static-audit gate `D12` (`bun run audit:invariants`) fails the build on any direct `db.run(` / `db.exec(` outside the wrapper.
