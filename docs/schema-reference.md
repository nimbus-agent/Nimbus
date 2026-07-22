# Local Database Schema Reference

The SQLite tables that back the local index, audit log, sync state, embeddings, and extension registry. This is **reference material** — extracted from [`architecture.md`](./architecture.md) so the architecture narrative stays focused on the system's shape rather than every column. Read it when you need exact column names, or when authoring a migration (pair with the [`nimbus-db-migrations`](../.claude/commands/nimbus-db-migrations.md) skill).

> **Canonical migration list:** the runner at [`packages/gateway/src/index/migrations/runner.ts`](../packages/gateway/src/index/migrations/runner.ts) holds the authoritative `INDEXED_SCHEMA_STEPS` array — each step pairs a `migrateIndexedV<N>ToV<M>` function with the SQL constants imported from sibling [`packages/gateway/src/index/`](../packages/gateway/src/index/) `*-v<N>-sql.ts` files. The runner wraps each step in a single transaction, writes a pre-migration backup to `<dataDir>/backups/pre-migration-V<N>-<timestamp>.db`, records success in the `_schema_migrations` ledger, and rolls back on a thrown migration. **Latest applied migration: V44** (`egress_ledger` provable-locality ledger, I29/D22 — S1 "Local Brain"; V43 `share_inbox` — Slice 8d; V42 `tool_call_log.params_json` — Slice 8b recipe; V41 `share_records` — Slice 8 Share & Virality; V40 lineage relation types `upstream_refs`/`derived_from`/`monitors` into `graph_relation_type` — Slice 7; V39 `tribal_clusters` — Slice 6c; V38 `federation_known_namespaces` — Slice 6a; V37 `gdpr_purge_job`/`gdpr_purge_request` — federation right-to-erasure; V36 `org_policy_state`/`policy_anchor_pin` — Slice 4 policy; V35 `team_vault_entries`/`team_vault_grants`/`hitl_delegations` — Slice 2 Team Vault + quorum HITL; V34 identity / SCIM tables — Phase 6 Slice 3; V33 added `federation_namespaces` / `federation_namespace_filters` / `federation_grants` + a nullable `audit_log.federation_json` column — Phase 6 Slice 1; V32 added `git_blame_line` — security scan v2; V31 added `extension_dependency` — Phase 5 T2 PR 4). Migrations are append-only and forward-only — no `down()` function. See [`.claude/commands/nimbus-db-migrations.md`](../.claude/commands/nimbus-db-migrations.md) for the authoring contract (numbering, batched backfill, FTS5 / vec0 cautions).
>
> The SQL block below is the **shape**, not a snapshot of every column. Phase 6+ tables will land as new migrations and new item types — `service` / `team` / `scorecard` / `dora_metric` (Phase 7), `security_finding` / `posture_finding` / `security_incident` / `sbom_artifact` (Phase 8), `llm_trace` / `ml_model` / `vector_index` / `ai_spend_event` (Phase 9), and the multimodal-understanding / sandbox-execution tables (Phase 14). See [`roadmap.md` § Planned](./roadmap.md#planned) for the phase index.

```sql
-- Core metadata index — the unified V3 `item` table.
-- Authoritative source: packages/gateway/src/index/unified-item-v3-sql.ts
--
-- The `type` column stores the connector's raw value VERBATIM. The vocabulary
-- lives in @nimbus-dev/sdk (`KnownItemType`) and is an OPEN enum
-- (`KnownItemType | (string & {})`), so a new connector can emit a new type
-- without a schema or SDK change. Never coerce an unrecognised type into a
-- recognised one — doing exactly that silently relabelled 55% of a live index
-- as "file" until #780 removed the coercion.
CREATE TABLE item (
    id            TEXT PRIMARY KEY,   -- "<service>:<external_id>"
    service       TEXT NOT NULL,      -- "google_drive" | "gmail" | "github" | "jenkins" | ...
    type          TEXT NOT NULL,      -- open enum; see above
    external_id   TEXT NOT NULL,      -- native id, NOT unique across services
    title         TEXT NOT NULL,
    body_preview  TEXT,
    url           TEXT,
    canonical_url TEXT,
    modified_at   INTEGER NOT NULL,   -- Unix ms
    author_id     TEXT,               -- references person(id)
    metadata      TEXT,               -- JSON blob: service-specific fields
    synced_at     INTEGER NOT NULL,
    pinned        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(service, external_id)
);

CREATE INDEX idx_item_service ON item(service);
CREATE INDEX idx_item_type ON item(type);
CREATE INDEX idx_item_modified_at ON item(modified_at);

-- Full-text search (FTS5) — kept in sync by AFTER INSERT/DELETE/UPDATE triggers
-- on `item` (item_fts_insert / item_fts_delete / item_fts_update).
CREATE VIRTUAL TABLE item_fts USING fts5(
    title, body_preview,
    content='item', content_rowid='rowid'
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

-- Federation (Phase 6 Slice 1): the consent-scoped federated query primitive. V33.
-- A namespace is a named, filtered slice of the local index a peer can query.
CREATE TABLE federation_namespaces (
    namespace_id TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,   -- e.g. "project:zurich"
    owner_self   INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
);

-- The declared filter set that bounds what a namespace exposes (query-gate compiles ONLY these).
CREATE TABLE federation_namespace_filters (
    namespace_id TEXT NOT NULL,
    filter_kind  TEXT NOT NULL,          -- CHECK IN ('service','type','tag')
    filter_value TEXT NOT NULL,
    PRIMARY KEY (namespace_id, filter_kind, filter_value)
);

-- Per-peer RBAC grant on a namespace; revocation is live-checked on every inbound query.
CREATE TABLE federation_grants (
    namespace_id     TEXT NOT NULL,
    peer_id          TEXT NOT NULL,
    role             TEXT NOT NULL,       -- CHECK IN ('owner','editor','viewer')
    standing_consent INTEGER NOT NULL DEFAULT 0,
    granted_at       INTEGER NOT NULL,
    revoked_at       INTEGER              -- NULL = active; set on revoke
    , PRIMARY KEY (namespace_id, peer_id)
);

-- Team Vault + multi-user/quorum HITL (Phase 6 Slice 2) — V35.
-- Metadata + RBAC only. Secret bytes live in the OS Vault under `teamvault.<entry>.<key>`,
-- NEVER in these tables. Quorum/delegation in-flight state is session-only. (I19, I20, I21.)
CREATE TABLE team_vault_entries (
    entry      TEXT PRIMARY KEY,
    service    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
);
-- Per-(entry, peer, tool) "use" grant; revocation is live-checked on every team-credentialed invoke.
CREATE TABLE team_vault_grants (
    entry      TEXT NOT NULL,
    peer_id    TEXT NOT NULL,
    tool_id    TEXT NOT NULL,
    mode       TEXT NOT NULL CHECK(mode IN ('use')),
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,                 -- NULL = active; set on revoke
    PRIMARY KEY (entry, peer_id, tool_id)
);
CREATE INDEX idx_tv_grants_peer ON team_vault_grants(peer_id);
-- Delegated-HITL grants: a live, in-scope, identity-valid delegate may approve on the owner's behalf (I20).
CREATE TABLE hitl_delegations (
    delegation_id TEXT PRIMARY KEY,
    delegate_peer TEXT NOT NULL,
    scope_kind    TEXT NOT NULL CHECK(scope_kind IN ('action_type','service')),
    scope_value   TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    revoked_at    INTEGER
);
CREATE INDEX idx_hitl_deleg_peer ON hitl_delegations(delegate_peer);

-- Signature-verified org policy + pinned trust anchor (Phase 6 — policy) — V36.
-- Singleton rows (id = 1). Enforcement reads the resolved `EnforcedPolicy`, never raw `toml` (I22).
CREATE TABLE org_policy_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    toml       TEXT NOT NULL,
    sig        TEXT NOT NULL,
    org        TEXT NOT NULL,
    version    INTEGER NOT NULL,
    issued_at  TEXT,
    fetched_at INTEGER NOT NULL,
    source     TEXT NOT NULL
);
CREATE TABLE policy_anchor_pin (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    pubkey    TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    source    TEXT NOT NULL
);

-- GDPR purge ledger (Phase 6 — federation right-to-erasure) — V37.
-- A purge job fans a delete request out to each peer; per-peer rows track retry + completion.
CREATE TABLE gdpr_purge_job (
    job_id         TEXT PRIMARY KEY,
    external_id    TEXT NOT NULL,
    opened_at      INTEGER NOT NULL,
    closed_at      INTEGER,
    completion_sig TEXT
);
CREATE TABLE gdpr_purge_request (
    job_id          TEXT NOT NULL,
    peer_id         TEXT NOT NULL,
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_ms INTEGER,
    deletion_record TEXT,
    PRIMARY KEY (job_id, peer_id)
);
CREATE INDEX idx_gdpr_request_pending ON gdpr_purge_request(status);

-- Asker-side known-namespaces cache (Phase 6 Slice 6a — cross-colleague agents) — V38.
-- Remote namespaces this gateway has successfully queried, so ghost/conflicts/huddle can fan out
-- ambiently without a namespace-discovery primitive. Append-only; keyed on the stable peer_id.
CREATE TABLE federation_known_namespaces (
    peer_id       TEXT NOT NULL,
    namespace     TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    PRIMARY KEY (peer_id, namespace)
);

-- Tribal-knowledge cluster ledger (Phase 6 Slice 6c) — V39.
-- One row per detected repeated-question cluster; survives restarts, dedups suggestions, and
-- tracks capture/dismiss + cooldown. The HITL-gated capture write itself is governed by I25.
CREATE TABLE tribal_clusters (
    cluster_id              TEXT PRIMARY KEY,
    representative_question TEXT NOT NULL,
    representative_vec      BLOB,
    occurrence_count        INTEGER NOT NULL DEFAULT 1,
    first_seen              INTEGER NOT NULL,
    last_seen               INTEGER NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending',
    channel_id              TEXT NOT NULL,
    platform                TEXT NOT NULL,
    suggested_at            INTEGER,
    cooldown_until          INTEGER,
    captured_page_ref       TEXT
);
CREATE INDEX idx_tribal_clusters_status  ON tribal_clusters(status);
CREATE INDEX idx_tribal_clusters_channel ON tribal_clusters(channel_id);

-- Data-warehouse / BI lineage relation types (Phase 6 Slice 7) — V40.
-- Not a new table: seeds three directed edge types into graph_relation_type (the V12 vocab table),
-- which graph_relation.type is FK-constrained to. These back the cross-warehouse lineage graph
-- (`upstream_refs` aligns with the path vocabulary agents/impact.ts already uses).
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
    ('upstream_refs', 1),
    ('derived_from', 1),
    ('monitors', 1);

-- Share & Virality ledger (Phase 6 Slice 8) — V41.
-- Persists redacted, signed shareable artifacts (transcripts / `--as-recipe` DAGs) with their
-- redaction set + provenance so a share can be listed, re-fetched by content hash, and pruned.
-- No row-level cloud data — only the share envelope. Outbound emit is gated by I27 (share-gate);
-- the body is signed with the Vault-only `share.signing.privkey`.
CREATE TABLE share_records (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash       TEXT NOT NULL UNIQUE,
    kind               TEXT NOT NULL,         -- "transcript" | "recipe"
    session_id         TEXT,
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER,
    redaction_set_json TEXT NOT NULL,         -- the applied redaction set (audit-logged)
    provenance_json    TEXT NOT NULL,
    body_json          TEXT NOT NULL,         -- the redacted, shareable body
    sig_json           TEXT NOT NULL,         -- Ed25519 signature over the body
    sink               TEXT NOT NULL
);
CREATE INDEX idx_share_records_session ON share_records(session_id);
CREATE INDEX idx_share_records_created ON share_records(created_at);

-- Recipe params capture (Phase 6 Slice 8b) — V42.
-- Adds the SECRET-redacted JSON of each tool call's input params to tool_call_log (V29), so a
-- session can be reconstructed as a declarative recipe DAG with real per-step params. Nullable +
-- no backfill: rows logged before V42 read back NULL. Secrets stripped at write via redactAuditPayload.
ALTER TABLE tool_call_log ADD COLUMN params_json TEXT;

-- Sovereign-mesh share inbox (Phase 6 Slice 8d) — V43.
-- One dual-purpose table keyed by recipient pubkey. `direction='pending'` = a sender-side forward
-- queued for a not-yet-paired recipient (drained on first pair); `direction='received'` = an inbound,
-- INERT forwarded share (viewable/replayable; never merged into the index, never executed — no HITL).
-- `share_json` is the full signed ShareFile (body + sig + forwarding envelope). Forwarding reuses I27.
-- Append-only; manual prune only.
CREATE TABLE share_inbox (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_pubkey TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    direction        TEXT NOT NULL,        -- "pending" | "received"
    share_json       TEXT NOT NULL,        -- full signed ShareFile (self-contained artifact)
    origin_label     TEXT NOT NULL,        -- denormalized for the attribution chip
    hops             INTEGER NOT NULL,     -- denormalized hop count for the attribution chip
    received_at      INTEGER NOT NULL,
    status           TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_share_inbox_unique
    ON share_inbox(recipient_pubkey, content_hash, direction);
CREATE INDEX idx_share_inbox_recipient ON share_inbox(recipient_pubkey);
CREATE INDEX idx_share_inbox_status    ON share_inbox(status);

-- Egress ledger (S1 "Local Brain" — provable-locality primitive) — V44.
-- An always-on, append-only, BLAKE3-chained ledger of every outbound action the executor
-- AUTHORIZES. Written from `engine/executor.ts` `gate()` BEFORE `connectors.dispatch` — a denied
-- gate records a `result_status='blocked'` row; an append failure aborts the action (fail-closed,
-- never dispatches). `destination` is the `serviceOf()` action-type prefix (NEVER a raw URL with a
-- query-string secret); `payload_summary` is `redactAuditPayload(action.payload)` capped at 256
-- bytes (a debugging aid, not the security boundary). `source_type='prune'` is the single tombstone
-- row class (the only sanctioned mutation — HITL-gated `egress.prune` — continues the chain rather
-- than leaving a silent gap). Chain reuses db/audit-chain.ts genesis + BLAKE3; offline verify is
-- timing-safe (I10). Append-only; manual prune only. See I29 / static D22.
CREATE TABLE egress_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    source_type     TEXT NOT NULL,          -- "agent" | "chatops" | "tribal" | "prune" | ...
    source_id       TEXT,
    destination     TEXT NOT NULL,          -- serviceOf() action-type prefix (e.g. "github")
    method          TEXT NOT NULL,          -- the action type
    payload_summary TEXT NOT NULL,          -- redactAuditPayload, capped 256 bytes
    hitl_status     TEXT NOT NULL CHECK(hitl_status IN ('approved','not_required','rejected')),
    result_status   TEXT NOT NULL CHECK(result_status IN ('authorized','blocked')),
    row_hash        TEXT NOT NULL,          -- BLAKE3(prev_hash || canonical_row_bytes)
    prev_hash       TEXT NOT NULL           -- chain link to previous row (genesis = 64×'0')
);
CREATE INDEX idx_egress_ledger_ts     ON egress_ledger(timestamp);
CREATE INDEX idx_egress_ledger_source ON egress_ledger(source_type, source_id);
CREATE INDEX idx_egress_ledger_dest   ON egress_ledger(destination);
```

**SQLite write boundary.** Every production write goes through `dbRun` / `dbExec` / `dbStmtRun` in `packages/gateway/src/db/write.ts` (invariant `I14`). The wrappers translate `SQLITE_FULL` into a typed `DiskFullError`; the static-audit gate `D12` (`bun run audit:invariants`) fails the build on any direct `db.run(` / `db.exec(` outside the wrapper.
