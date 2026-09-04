# Local Database Schema Reference

The SQLite tables that back the local index, audit log, sync state, embeddings, and extension registry. This is **reference material** — extracted from [`architecture.md`](./architecture.md) so the architecture narrative stays focused on the system's shape rather than every column. Read it when you need exact column names, or when authoring a migration (pair with the [`nimbus-db-migrations`](../.claude/commands/nimbus-db-migrations.md) skill).

> **Canonical migration list:** the runner at `packages/gateway/src/index/migrations/runner.ts` holds the authoritative `INDEXED_SCHEMA_STEPS` array — each step pairs a `migrateIndexedV<N>ToV<M>` function with the SQL constants imported from sibling `packages/gateway/src/index/` `*-v<N>-sql.ts` files. The runner wraps each step in a single transaction, writes a pre-migration backup to `<dataDir>/backups/pre-migration-V<N>-<timestamp>.db`, records success in the `_schema_migrations` ledger, and rolls back on a thrown migration. **Latest applied migration: V58** (`media-pass-v58-sql.ts` -- spec § 6.2 -- ONE table, `media_pass_cursor`: `pass_id` PK, a nullable `service`/`modality` scope, `last_item_id`, `processed_count` and `updated_at`, `WITHOUT ROWID`. It is SQLite-backed rather than in-memory for one reason: a BUDGETED pass over a large media library is only worth budgeting if it resumes across a gateway restart, and an in-memory cursor restarts the library from the top every time the gateway does. The per-root media GRANTS are deliberately NOT here -- they land with a later multimodal PR. Schema is forward-only, so a table created three PRs before anything reads it is drift waiting to happen. No new invariant -- S2 multimodal I/O, slice 1 of 4.) **V57** (`computer-use-v57-sql.ts` -- spec § 8.3 -- TWO tables, `cu_session` and `cu_action`, backing the local computer-use loop (invariant **I35**, static rule **D26**). A deliberate split of duty against `audit_log`, mirroring I33's own split between the code body it records in full and the output it records as digests: the DECISIONS -- what was approved, what happened -- ride the chained `audit_log` as permanent `computer.action` rows; these two tables carry the bulky REPLAY BODY, which ages out. `cu_session` is one row per session: `lane` CHECK'd to `'browser'`/`'terminal'`/`'screen'`, of which `browser` and `terminal` now both have a session GATE and a DRIVER (the raw-CDP browser driver landed 2026-08-31, the pipe-backed terminal lane 2026-09-01) and `screen` has neither -- the value set is known now and widening a CHECK later is a table rebuild, the same reasoning that froze `EGRESS_SOURCE_TYPES` complete -- the approved `envelope_json` verbatim, and `tainted_at`, the one-way taint-latch timestamp (NULL until the first untrusted observation) -- a durable FORENSIC record of when untrusted content entered the session, not an enforcement mechanism: the envelope's immutability (origins can never grow, budgets can never rise) is enforced separately, at construction, by `CuSession` deep-freezing the envelope and both origin arrays when the session opens, independent of whether the latch has been set. `cu_action` is one row per actuation, `UNIQUE (session_id, seq)`, `session_id REFERENCES cu_session(id) ON DELETE CASCADE`. `observed_target` and `model_description` are DELIBERATELY separate columns: `observed_target` is what the classifier read -- a fact the gateway derived from the live DOM -- and `model_description` is what the model SAID it was doing -- attacker-influenceable, recorded for forensics, never an input to any decision; collapsing the two would destroy the one distinction the whole design turns on, inside the exact record an incident responder reads. `dom_before`/`dom_after` hold the browser lane's before/after DOM snapshot, the higher-fidelity replay record precisely because there is no lower-fidelity one: **no screenshot PIXEL or BLOB column exists on either table, on purpose** -- screenshot pixels are never persisted, on any lane, at any point. `screenshot_digest` is the sole screenshot-derived field and holds a BLAKE3 digest only, computed with the source bytes discarded in the same expression. (The earlier wording said no screenshot column existed "of any kind" and then documented `screenshot_digest` two clauses later; the claim worth making is about pixels, not about the word.) A snapshot above `[computer_use] snapshot_max_bytes` (default 262144) is stored truncated, with `dom_truncated`/`dom_original_bytes` recording the clip so a reader can never mistake a clipped snapshot for a complete one -- the same `truncated` convention `pr_files_state` above and `exec` already use; `[computer_use] snapshot_retention_days` (default 7) NULLs both DOM columns past the window on a daily prune pass, while the `audit_log` decision row survives permanently -- deliberately NOT folded into `egress.prune`, since that HITL-gated tombstone is the sole mutation `egress_ledger`'s chain-integrity claim rests on, and widening it to service an unrelated table would dilute that claim. Both tables are `WITHOUT ROWID`. No new IPC method beyond the `computer.*` namespace itself (see `architecture.md`'s IPC catalogue) -- S2 computer-use; full column detail below. V56 (`connector-configured-v56-sql.ts` -- adds `sync_state.configured`, so a connector nobody ever set up stops reporting itself `healthy` with a recent `lastSyncAt`; see the `sync_state` DDL below for why it is a new column rather than a widened `health_state` CHECK). V55 (`pr-changed-file-v55-sql.ts` — adds `pr_changed_file` + `pr_files_state`, both keyed on `item.id` (`REFERENCES item(id) ON DELETE CASCADE`) and both `WITHOUT ROWID`. `pr_changed_file` stores ONE ROW PER TOUCHED PATH — a rename writes TWO rows (old path and new), a deletion writes ONE — so a single index on `path` answers a membership question with no special-casing; `status` is descriptive only, never load-bearing for a predicate. Its `local_file_id` column (`REFERENCES graph_entity(id) ON DELETE SET NULL`) links a changed path to the ownership graph, but ships **unpopulated in this delivery** — the column, its foreign key, and its `SET NULL` behaviour all exist, but the ownership pass that would write it is deliberately deferred, since nothing in this delivery reads it (a negation query matches on `path` alone); a `NULL` here means "not yet linked," not "no local file exists." `pr_files_state` is the per-PR fetch-coverage record (`fetched_at_ms` / `api_file_count` / `stored_count` / `truncated`), written once per PR by the bounded per-tick driver `runPrFilePass` (`prfiles/pr-file-fetch.ts` — `MAX_PRS_PER_TICK = 10` rows recorded per tick, attempted against a `PR_ATTEMPT_BUDGET_MULTIPLIER`-times-larger candidate selection so a permanently-failing newest-first head cannot pin coverage at zero) across three forge mappers — GitHub `pulls/{n}/files`, GitLab MR diffs, Bitbucket diffstat — so coverage grows over many sync ticks rather than completing on the first sync. Ships the fail-closed negation primitive, `selectPrsNotTouching` (`prfiles/pr-changed-file-store.ts`) — a PR is excluded for TWO independent reasons, enforced by two independent SQL mechanisms: it has no `pr_files_state` row (the `JOIN` finds nothing), or its row has `truncated = 1` (`s.truncated = 0` in the `WHERE` clause; on an uncovered PR that column is `NULL`, and `NULL = 0` evaluates to `NULL`, which `WHERE` treats as not-true, so an uncovered PR is excluded by both mechanisms at once) — but no predicate language (`--negate`, `--touches`) ships in this delivery; that is a later PR (W6-B) calling this primitive. `nimbus status` gains a `PR file coverage: <covered> / <totalPrs>` line, its `(<N> truncated)` suffix present only when truncated PRs exist, omitted entirely when no PRs are indexed. No new IPC method — `ALLOWED_METHODS` stays 105 — S1 "Local Brain"; full column detail below. V54 (`entity-metadata-v54-sql.ts` — adds no table or column; it rewrites existing `graph_entity.metadata` values, `UPDATE`-in-place, for the six co-owned entity types (`source_file` / `directory` / `person` / `service` / `workspace` / `repo`), wrapping a value as `{"ownership": <existing value>}` only where it is non-null, `json_valid`, a JSON **object** and not already namespaced — a malformed or scalar value is left exactly as it is — so `graph_entity`'s single flat metadata column becomes a per-writer namespace map. Fixes a last-writer-wins bug: `graph/graph-populator.ts`'s code-symbol sync and `ownership/ownership-pass.ts`'s owner-count pass write the same `source_file` entities (byte-identical `file:<repoRoot>:<path>` ids, deliberately), and the flat `upsertGraphEntity`'s `metadata = excluded.metadata` let either one silently NULL the other's data — `nimbus owners` alternated between its real output and an "owner breakdown not recorded" line, with no error and no gap note. Both writers now go through the new `upsertGraphEntityNamespaced`, which merges via two sequential `json_patch` calls (a `null` patch clearing the writer's own namespace, then a set patch replacing it) rather than the flat overwrite; `graph_entity`'s column set is unchanged, so there is no new table shape to add below. `service` and `label` are still last-writer-wins on these types — deliberately out of scope. The residual clobber is no longer the flat statement (co-owned types no longer reach it) but `upsertGraphEntityNamespaced`'s own `SET label = excluded.label, service = excluded.service`, which namespaces `metadata` alone; `ownership-pass.ts` already derives file scope from its own `contains` edges rather than relying on the `service` column. A static audit rule (`scripts/structure-audit/check-nimbus-invariants.ts`) rejects a flat `upsertGraphEntity` write on a co-owned type outside `relationship-graph.ts` itself — exempting `.test.ts` files and resolving literal `type:` arguments only, the same two bounds the `NonCoOwnedType<T>` compiler guard has — S1 "Local Brain". V53 (`premortem-v53-sql.ts` — `premortem_theme` / `premortem_theme_evidence` / `premortem_pass_state` / `premortem_watcher_proposal`, the schema for a debounced background pass that mines recurring blocker themes per service from closed epics; `premortem_watcher_proposal` is written by a later PR, not this one — the table lands here because schema precedes its reader; no user-facing command ships with V53, and the discover stage is Jira-only today (see below) — S1 "Local Brain"; full column detail below. **Note:** V50–V52 are not narrated in this reference — V51 added the ownership relation types (`owns` / `contains` / `tracks_remote`) + `ownership_pass_state`, and V52 added `item.resolve_key`; both landed without a `schema-reference.md` update, and V53 closes that gap only for itself, not retroactively. V49 (`depth-default-v49-sql.ts` — `UPDATE sync_state SET depth = 'full' WHERE depth = 'summary'`, which makes the per-connector depth setting real before connector-index-depth enforcement starts honouring it, deliberately leaving `metadata_only` rows untouched, S1 "Local Brain"; V48 `item.body` + `item.body_complete`, with `item_fts` repointed from `body_preview` to `body` — the full-body store, lifting the 512-character cap to 16 KiB for `PROSE_HEAVY_TYPES`, S1 "Local Brain"; V47 `decision_record` + `decision_evidence` + `decision_pass_state` — implicit ADR extractor, S1 "Local Brain"; V46 full-table rebuild of `glossary_term` widening `definition_source` to `CHECK(... IN ('llm','snippet','manual'))` for manual term authoring — S1 "Local Brain"; V45 `glossary_term` + `glossary_pass_state` implicit-knowledge glossary — S1 "Local Brain"; V44 `egress_ledger` provable-locality ledger, I29/D22 — S1 "Local Brain"; V43 `share_inbox` — Slice 8d; V42 `tool_call_log.params_json` — Slice 8b recipe; V41 `share_records` — Slice 8 Share & Virality; V40 lineage relation types `upstream_refs`/`derived_from`/`monitors` into `graph_relation_type` — Slice 7; V39 `tribal_clusters` — Slice 6c; V38 `federation_known_namespaces` — Slice 6a; V37 `gdpr_purge_job`/`gdpr_purge_request` — federation right-to-erasure; V36 `org_policy_state`/`policy_anchor_pin` — Slice 4 policy; V35 `team_vault_entries`/`team_vault_grants`/`hitl_delegations` — Slice 2 Team Vault + quorum HITL; V34 identity / SCIM tables — Phase 6 Slice 3; V33 added `federation_namespaces` / `federation_namespace_filters` / `federation_grants` + a nullable `audit_log.federation_json` column — Phase 6 Slice 1; V32 added `git_blame_line` — security scan v2; V31 added `extension_dependency` — Phase 5 T2 PR 4). Migrations are append-only and forward-only — no `down()` function. See [`.claude/commands/nimbus-db-migrations.md`](../.claude/commands/nimbus-db-migrations.md) for the authoring contract (numbering, batched backfill, FTS5 / vec0 cautions).
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
    body          TEXT,               -- V48: up to 16 KiB for PROSE_HEAVY_TYPES, else 512 (index/body-caps.ts)
    body_preview  TEXT,               -- V48: derived 512-char prefix of `body`, never written independently
    body_complete INTEGER NOT NULL DEFAULT 0,  -- V48: 1 only when a connector declared a full `body` that fit under its type's cap
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
-- V48 repointed the indexed body column from `body_preview` (512-char cap) to
-- `body` (up to 16 KiB for PROSE_HEAVY_TYPES) — see body-store-v48-sql.ts. The
-- migration seeds `body = body_preview` before rebuilding so no existing row's
-- keyword coverage regresses.
CREATE VIRTUAL TABLE item_fts USING fts5(
    title, body,
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
    context_window_tokens INTEGER,
    -- V56: has a credential for this connector ever been stored?
    -- Separate from health_state on purpose. That column carries a column-level CHECK pinned to
    -- six values, and SQLite cannot widen a CHECK without rebuilding the table -- a drop-and-
    -- rename of the scheduler core table holding live cursors, which the append-only migration
    -- rule forbids. The two also answer different questions: health_state records how the last
    -- REAL attempt went, and removing a credential does not retroactively change that.
    -- getConnectorHealth derives the single `not_configured` state consumers read, so nothing
    -- downstream needs to know there are two columns. DEFAULT 1 because rows exist only for
    -- connectors the scheduler actually ran.
    configured      INTEGER NOT NULL DEFAULT 1
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

-- Implicit-knowledge glossary (S1 "Local Brain") — V45, `definition_source` widened by V46.
-- `glossary_term` is the SSoT for the extraction pass: it holds candidates in every status,
-- including `pending` work not yet consolidated and `vetoed` rejections that must never be
-- re-asked. Only `status='consolidated'` rows are projected into the searchable `item` table as
-- `nimbus:glossary_term` (see `glossary/glossary-project.ts`); a term leaving `consolidated`
-- (demoted by the reconciliation sweep, or re-vetoed) has its projected item row deleted.
-- `first_seen_at` / `last_seen_at` are CONTENT dates — MIN/MAX(item.modified_at) across the items
-- citing the term — not row timestamps; they are RECOMPUTED every time the term's statistics are
-- touched, never stamped once on insert, so they track when the team actually used the term
-- rather than when Nimbus happened to notice it. `attempts` / `last_attempt_at` back an
-- exponential retry backoff (capped 24h) over the pending-consolidation queue: a term whose LLM
-- call failed or timed out stays `pending` rather than `vetoed` (an infrastructure failure is not
-- a judgment about the term), and without backoff the same high-scoring failure would be
-- re-selected — and re-fail — every pass forever, starving every lower-scoring term behind it.
-- `stats_verified_at` drives the separate reconciliation sweep (round-robin oldest-first): it is
-- stamped whenever a term's statistics are freshly recomputed (at consolidation, and at each
-- sweep re-verification), so a term whose sources were later deleted or edited away — which the
-- incremental mining scan can never rediscover, since there is no surviving item to re-scan — is
-- still revisited on a bounded cadence and demoted back to `pending` if it now falls below
-- `min_doc_freq`. Every write goes through `dbRun` (I14); see `glossary/glossary-store.ts`.
-- V46 (manual term authoring) widened `definition_source` to also allow `'manual'`: an authored
-- row from `[glossary.terms]`/`[glossary.synonyms]` in `nimbus.toml`, upserted straight to
-- `consolidated` by a pre-pass (`glossary/glossary-manual.ts`) with no LLM call. Manual rows are
-- exempt from the reconciliation sweep's demotion and veto (a human assertion outranks the
-- doc-frequency floor) but NOT from its statistics refresh — `top_sources` still self-heals as
-- cited items are deleted or edited. SQLite cannot alter a CHECK constraint in place, so V46 is a
-- full table rebuild (`glossary_term_v46` built, populated, swapped in), not an in-place edit.
CREATE TABLE IF NOT EXISTS glossary_term (
    term_key          TEXT PRIMARY KEY,      -- normalized: casefold + de-pluralized + backticks stripped
    display_term      TEXT NOT NULL,         -- first surface form observed in the scan batch (overwritten each pass, not frequency-tracked)
    status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
    definition        TEXT,                  -- NULL until consolidated
    definition_source TEXT CHECK(definition_source IN ('llm','snippet','manual')),  -- V46 widened to add 'manual'
    doc_freq          INTEGER NOT NULL DEFAULT 0,   -- recomputed from item_fts, never accumulated
    service_spread    INTEGER NOT NULL DEFAULT 0,   -- COUNT(DISTINCT service) among citing items
    score             REAL    NOT NULL DEFAULT 0,   -- log1p(doc_freq) * 1.6^(service_spread-1) * formBoost
    form              TEXT    NOT NULL DEFAULT 'phrase',  -- mining family; re-used by the reconciliation sweep
    first_seen_at     INTEGER NOT NULL,      -- MIN(item.modified_at) over citing items — a CONTENT date
    last_seen_at      INTEGER NOT NULL,      -- MAX(item.modified_at) over citing items — a CONTENT date
    top_sources       TEXT NOT NULL DEFAULT '[]',  -- JSON [{itemId,title,url,service,modifiedAt}], max 5
    synonyms          TEXT NOT NULL DEFAULT '[]',  -- JSON string[] — LLM alsoKnownAs + detected acronym expansions
    near_misses       TEXT NOT NULL DEFAULT '[]',  -- JSON string[] — edit-distance <=2 term keys (no shared-stem matching)
    consolidated_at   INTEGER,               -- NULL until first consolidation; cleared on demotion
    stats_verified_at INTEGER NOT NULL DEFAULT 0,  -- last recompute; drives the reconciliation sweep round-robin
    attempts          INTEGER NOT NULL DEFAULT 0,   -- failed-consolidation count; feeds the retry backoff
    last_attempt_at   INTEGER NOT NULL DEFAULT 0,   -- last consolidation attempt, success or failure
    updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score
    ON glossary_term(status, score DESC);          -- the pending-consolidation batch select
CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt
    ON glossary_term(status, last_attempt_at);      -- the retry-backoff filter
CREATE INDEX IF NOT EXISTS idx_glossary_term_display
    ON glossary_term(display_term);
CREATE INDEX IF NOT EXISTS idx_glossary_term_verified
    ON glossary_term(status, stats_verified_at);    -- the reconciliation sweep's oldest-first select

-- Single-row watermark for the extraction pass. `id` is CHECK'd to 1 so the table can never hold
-- more than one row (the same single-row pattern as other watermark tables in this schema).
CREATE TABLE IF NOT EXISTS glossary_pass_state (
    id            INTEGER PRIMARY KEY CHECK(id = 1),
    watermark_ms  INTEGER NOT NULL DEFAULT 0,   -- modified_at of the last row the scan consumed
    watermark_id  TEXT    NOT NULL DEFAULT '',  -- item.id tiebreaker: the cursor is (modified_at, id),
                                                -- so a batch truncated inside a group of rows sharing
                                                -- one modified_at resumes instead of skipping the rest
    last_pass_at  INTEGER,                      -- wall-clock time of the last completed pass
    last_pass_new INTEGER NOT NULL DEFAULT 0,    -- new candidates discovered by the last pass
    scanned_items INTEGER NOT NULL DEFAULT 0     -- items scanned by the last pass
);

-- Implicit ADR extractor (S1 "Local Brain") — V47.
-- `decision_record.id` is content-derived: hash(source_item_id, normalized cue sentence). It is
-- deliberately NOT positional. Keying on the cue's character offset would mean a typo fix earlier
-- in a document re-hashes every later cue, re-queueing extracted rows AND resurrecting `vetoed`
-- ones under new ids — which would defeat the whole reason this table has no foreign key.
-- `source_item_id` carries NO foreign key on purpose. `vetoed` rows are the durable record of
-- model calls already spent; cascading them away on an index reset would re-burn the extraction
-- budget on candidates already rejected. The reconciliation sweep demotes rows whose source is
-- gone instead. `decision_evidence` DOES cascade — it is derived, cheap to recompute, and
-- meaningless without its parent.
-- `priority` and `confidence` are two different numbers on purpose. `priority` is knowable before
-- the model runs (cue strength + source authority) and orders the extraction queue. `confidence`
-- needs corroboration and completeness, so it is 0 for every pending row and must never be used
-- to order that queue. `decided_at` is a CONTENT date — the source item's `modified_at` — never a
-- row timestamp.
CREATE TABLE IF NOT EXISTS decision_record (
    id                TEXT PRIMARY KEY,   -- hash(source_item_id, normalized cue sentence) — content-derived, not positional
    source_item_id    TEXT NOT NULL,      -- references item(id); deliberately NO foreign key — see above
    status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
    statement         TEXT,               -- NULL until extracted
    rationale         TEXT,               -- NULL until extracted
    alternatives      TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
    extraction_source TEXT CHECK(extraction_source IN ('llm','snippet')),
    cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
    cue_text          TEXT NOT NULL,
    priority          REAL NOT NULL DEFAULT 0,   -- knowable pre-extraction: cue strength + source authority; orders the queue
    confidence        REAL NOT NULL DEFAULT 0,   -- 0 for every pending row; needs corroboration — must never order the queue
    decided_at        INTEGER NOT NULL,   -- CONTENT date: source item's modified_at, never a row timestamp
    has_adr           INTEGER NOT NULL DEFAULT 0,
    stats_verified_at INTEGER NOT NULL DEFAULT 0,
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_attempt_at   INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_status_confidence
    ON decision_record(status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_decision_pending_priority
    ON decision_record(status, priority DESC, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_decision_decided_at
    ON decision_record(status, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_verified
    ON decision_record(status, stats_verified_at);
CREATE INDEX IF NOT EXISTS idx_decision_source_item
    ON decision_record(source_item_id);

-- `kind` includes `'migration'` and `'iac'` for forward-compatibility, but nothing emits them
-- today — both would need changed-file paths that no connector currently indexes. They stay in
-- the CHECK so the schema does not need to change the day a connector starts supplying them; the
-- doc should not be read as implying evidence kinds the system can produce now.
CREATE TABLE IF NOT EXISTS decision_evidence (
    decision_id  TEXT NOT NULL REFERENCES decision_record(id) ON DELETE CASCADE,  -- derived data — DOES cascade, unlike source_item_id above
    kind         TEXT NOT NULL CHECK(kind IN ('source','pr','commit','migration','iac','adr')),
    entity_id    TEXT,
    item_id      TEXT,
    label        TEXT NOT NULL,
    url          TEXT,
    occurred_at  INTEGER,
    PRIMARY KEY (decision_id, kind, label)
);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_decision
    ON decision_evidence(decision_id);

-- Single-row watermark for the extraction pass, same pattern as `glossary_pass_state` above.
-- The cursor is COMPOSITE (`watermark_ms` + `watermark_id`), not just a timestamp: a bulk import
-- stamping thousands of rows with one job-level timestamp would otherwise let a batch truncated
-- inside that group skip the remainder permanently. `watermark_id` breaks the tie on `item.id`, a
-- primary key and therefore total.
CREATE TABLE IF NOT EXISTS decision_pass_state (
    id            INTEGER PRIMARY KEY CHECK(id = 1),
    watermark_ms  INTEGER NOT NULL DEFAULT 0,   -- modified_at of the last row the scan consumed
    watermark_id  TEXT    NOT NULL DEFAULT '',  -- item.id tiebreaker within a shared modified_at group
    last_pass_at  INTEGER,                      -- wall-clock time of the last completed pass
    last_pass_new INTEGER NOT NULL DEFAULT 0,    -- new candidates discovered by the last pass
    scanned_items INTEGER NOT NULL DEFAULT 0     -- items scanned by the last pass
);

-- Pre-mortem recurring-blocker-theme extraction (S1 "Local Brain") — V53.
-- PR A only: schema + a debounced background pass (discover closed epics -> extract themes via a
-- local LLM -> reconcile). No user-facing command ships with this migration — `nimbus pre-mortem`
-- and the `agents.premortem` read brief are a later PR. The discover stage is Jira-only today: it
-- keys on `metadata.issue_type = 'Epic'`, written only by `jira-sync.ts` — `linear-sync.ts` never
-- writes `issue_type`, and no `linear:project` items are indexed at all, so there is no Linear
-- epic-shaped row to mine yet.
-- `premortem_theme.id` is CONTENT-DERIVED = hash(service, normalized label), never positional —
-- the same reason `decision_record.id` above is content-derived: a positional key would re-hash
-- every later theme when text earlier in a document changes, orphaning accumulated evidence rows
-- and re-spending the extraction budget on a theme already mined. `service` is the AFFECTED
-- service an epic's work touched (e.g. `billing-api`), never the connector that owns the row
-- (`jira`) — derived by `premortem/epic-services.ts` `affectedServicesForEpic`.
CREATE TABLE IF NOT EXISTS premortem_theme (
    id            TEXT PRIMARY KEY,   -- hash(service, normalized label) — content-derived, not positional
    service       TEXT NOT NULL,      -- the AFFECTED service, never the connector (`jira`)
    label         TEXT NOT NULL,
    normalized    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK(status IN ('extracted','demoted')),
    confidence    REAL NOT NULL DEFAULT 0,   -- derived from evidence count, ceiling 0.86
    first_seen_at INTEGER NOT NULL DEFAULT 0,
    last_seen_at  INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_premortem_theme_service_norm
    ON premortem_theme(service, normalized);
CREATE INDEX IF NOT EXISTS idx_premortem_theme_service_status
    ON premortem_theme(service, status, confidence DESC);

-- Evidence rows carry a composite primary key, so re-supplying one on a later pass is a no-op
-- rather than a duplicate — which is what keeps `premortem_theme.confidence` (recomputed from the
-- stored count) honest across repeated passes. No foreign key on `item_id`: items are synced and
-- pruned dynamically, so a periodic sweep (`pruneOrphanedEvidence`) deletes evidence whose source
-- item has left the index and recomputes confidence for every theme that lost a row.
CREATE TABLE IF NOT EXISTS premortem_theme_evidence (
    theme_id     TEXT NOT NULL REFERENCES premortem_theme(id) ON DELETE CASCADE,
    item_id      TEXT NOT NULL,      -- references item(id); deliberately NO foreign key — see above
    evidence_key TEXT NOT NULL,
    label        TEXT NOT NULL,
    url          TEXT,
    occurred_at  INTEGER,            -- CONTENT date (the source epic's resolved_at_ms); omitted, never 0, when absent
    PRIMARY KEY (theme_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS idx_premortem_evidence_theme
    ON premortem_theme_evidence(theme_id);
CREATE INDEX IF NOT EXISTS idx_premortem_evidence_item
    ON premortem_theme_evidence(item_id);

-- Single-row watermark for the discover stage, same COMPOSITE-cursor pattern as
-- `decision_pass_state` / `glossary_pass_state` above: `watermark_ms` alone cannot express "resume
-- inside a group of items sharing one modified_at", and a bulk import stamping thousands of rows
-- with one job-level timestamp makes that ordinary. `watermark_id` breaks the tie on `item.id`, a
-- primary key and therefore total. The watermark advances ONLY for a batch whose model call
-- actually ran: no configured model, an unavailable local provider, or a thrown call all leave it
-- untouched so those epics are retried later. A model that DID respond but returned unusable output
-- does advance it — otherwise a persistently bad model would loop on the same epics forever.
CREATE TABLE IF NOT EXISTS premortem_pass_state (
    id            INTEGER PRIMARY KEY CHECK(id = 1),
    watermark_ms  INTEGER NOT NULL DEFAULT 0,   -- modified_at of the last row the scan consumed
    watermark_id  TEXT    NOT NULL DEFAULT '',  -- item.id tiebreaker within a shared modified_at group
    last_pass_at  INTEGER,                      -- wall-clock time of the last completed pass
    last_pass_new INTEGER NOT NULL DEFAULT 0,    -- new themes discovered by the last pass
    scanned_items INTEGER NOT NULL DEFAULT 0     -- items scanned by the last pass
);

-- Written by a LATER PR, not this one — the table lands with V53 because schema precedes its
-- reader. Records every watcher id pre-mortem has ever proposed, so an id present here but ABSENT
-- from `watcher` is one the user deleted deliberately and must never be re-created.
CREATE TABLE IF NOT EXISTS premortem_watcher_proposal (
    watcher_id   TEXT PRIMARY KEY,
    epic_item_id TEXT NOT NULL,
    risk_kind    TEXT NOT NULL,
    service      TEXT NOT NULL,
    proposed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_premortem_proposal_epic
    ON premortem_watcher_proposal(epic_item_id);

-- PR changed-file paths plus their fetch-coverage record (S1 "Local Brain") — V55.
-- Keyed on `item.id` (already `itemPrimaryKey(service, externalId)`) rather than on
-- `(service, pr_external_id)`: the pair is redundant, and the cascade gives pruning for free.
-- ONE ROW PER TOUCHED PATH: a rename writes TWO rows (old path and new), a deletion writes ONE, so
-- a single index on `path` answers "did this PR touch X" with no special cases. `status` is
-- descriptive only — nothing correctness-bearing branches on it; membership in this table is what
-- decides a predicate. `counterpart_path` records a rename's other half for display only.
-- `local_file_id` ships UNPOPULATED in this delivery: the column, its foreign key, and its
-- `ON DELETE SET NULL` behaviour all exist, but nothing writes it yet — the spec assigns that to
-- the ownership pass, deliberately deferred because nothing in this delivery reads it (a negation
-- query matches on `path` alone). A NULL here means "not yet linked," never "no local file exists."
CREATE TABLE IF NOT EXISTS pr_changed_file (
    item_id          TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
    repo_full        TEXT NOT NULL,
    path             TEXT NOT NULL,
    status           TEXT NOT NULL,   -- descriptive only: 'added' | 'removed' | 'renamed' | 'modified'
    counterpart_path TEXT,            -- rename's other-half path, display only
    local_file_id    TEXT REFERENCES graph_entity(id) ON DELETE SET NULL,  -- UNPOPULATED — see above
    PRIMARY KEY (item_id, path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_pr_changed_file_path ON pr_changed_file(path);
CREATE INDEX IF NOT EXISTS idx_pr_changed_file_local ON pr_changed_file(local_file_id);

-- The coverage record. Its cascade matters in the opposite direction from storage hygiene: a
-- coverage row outliving its PR would claim "we know this PR's files" after the file rows were
-- cascaded away — asserting verification the index no longer holds. `truncated` is the second of
-- the two independent fail-closed mechanisms `selectPrsNotTouching` relies on (the first is the
-- `JOIN` to this table itself) — see `prfiles/pr-changed-file-store.ts`.
CREATE TABLE IF NOT EXISTS pr_files_state (
    item_id        TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
    fetched_at_ms  INTEGER NOT NULL,
    api_file_count INTEGER NOT NULL,
    stored_count   INTEGER NOT NULL,
    truncated      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Computer-use session envelopes (S2, browser lane; invariant I35, static D26). One row per
-- session opened by `computer.sessionOpen`. `lane` carries all three lane values even though only
-- `browser` has both a session gate and a driver (the raw-CDP driver landed 2026-08-31;
-- `terminal`/`screen` have neither) -- the value set is known now, and widening a CHECK
-- later is a table rebuild. `envelope_json` is the OWNER-APPROVED envelope, verbatim -- lane,
-- the full navigateOrigins/scriptOrigins lists, the action and wall-clock budgets -- never
-- reconstructed from other columns. `tainted_at` is the one-way taint latch: NULL until the first
-- untrusted observation -- a forensic record, not an enforcement mechanism. The envelope's
-- immutability is enforced separately, at construction: `CuSession` deep-freezes the envelope and
-- both origin arrays when the session opens, so origins can never grow and budgets can never rise,
-- independent of this column.
CREATE TABLE IF NOT EXISTS cu_session (
    id            TEXT PRIMARY KEY,
    lane          TEXT NOT NULL CHECK(lane IN ('browser','terminal','screen')),
    envelope_json TEXT NOT NULL,
    opened_at     INTEGER NOT NULL,
    closed_at     INTEGER,
    close_reason  TEXT,
    tainted_at    INTEGER,
    actions_used  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- The action stream -- the REPLAY BODY, as distinct from the PERMANENT decision recorded in
-- `audit_log`'s chained `computer.action` rows (I33's own split, reused). `observed_target` (what
-- the classifier read, a gateway-derived FACT) and `model_description` (what the model SAID it was
-- doing, an untrusted CLAIM recorded for forensics only) are separate columns on purpose --
-- collapsing them would destroy the one distinction invariant I35's consent prompt turns on, in
-- the exact record an incident responder reads. `dom_before`/`dom_after` are the browser lane's
-- before/after DOM snapshot; `dom_truncated`/`dom_original_bytes` exist so a clipped snapshot can
-- never be mistaken for a complete one (both NULLed by `[computer_use] snapshot_retention_days`
-- retention -- the audit_log row survives). `screenshot_digest` is the ONLY screenshot-shaped
-- column on either table: a BLAKE3 digest, computed and the source bytes discarded in the same
-- expression -- pixels are NEVER persisted, on any lane, at any point.
CREATE TABLE IF NOT EXISTS cu_action (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES cu_session(id) ON DELETE CASCADE,
    seq                INTEGER NOT NULL,
    kind               TEXT NOT NULL,
    classification     TEXT NOT NULL CHECK(classification IN ('observing','actuating')),
    observed_target    TEXT NOT NULL,
    model_description  TEXT,
    hitl_status        TEXT NOT NULL,
    outcome            TEXT NOT NULL,
    dom_before         TEXT,
    dom_after          TEXT,
    dom_truncated      INTEGER NOT NULL DEFAULT 0 CHECK(dom_truncated IN (0, 1)),
    dom_original_bytes INTEGER,
    screenshot_digest  TEXT,
    timestamp          INTEGER NOT NULL,
    UNIQUE (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cu_action_session ON cu_action(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_cu_action_time ON cu_action(timestamp);
```

**SQLite write boundary.** Every production write goes through `dbRun` / `dbExec` / `dbStmtRun` in `packages/gateway/src/db/write.ts` (invariant `I14`). The wrappers translate `SQLITE_FULL` into a typed `DiskFullError`; the static-audit gate `D12` (`bun run audit:invariants`) fails the build on any direct `db.run(` / `db.exec(` outside the wrapper.
