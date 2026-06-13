# Phase 6 Slice 7 — Data Warehouse & BI connectors (design)

**Date:** 2026-06-13
**Branch:** `dev/asafgolombek/phase6-slice7-data-warehouse-bi` (worktree `.claude/worktrees/phase6-slice7`, off main `fbe95070`)
**Status:** design — reviewed (see `…-design-review.md`); F1–F5 fixes applied inline, F3/F6/F7 deferred to plan; pending user sign-off before writing-plans
**Depends on:** Slice 1 (Federation Core), Slice 2 (Team Vault + I19 invoke-gate), Slice 3 (Identity/SSO) — all shipped
**Roadmap rows:** `docs/roadmap.md` slice table row 7 · "Data Warehouses & BI (SSO-gated)" feature subsection · cross-warehouse lineage acceptance (line 882)

---

## 1. Summary

Six net-new first-party MCP connectors — **Snowflake, Tableau, Looker, PowerBI, Monte Carlo,
Bigeye** — that index a team's warehouse + BI surface into the **existing** `data_model` /
`dashboard` / `data_quality_test` item types, emit **cross-connector lineage edges** during sync,
and expose **seven HITL-gated write actions**. Credentials default to **personal Vault** and can
**optionally** be sourced from a shared **Team-Vault** service account via the existing **I19**
invoke-gate — the feature that makes this a Phase-6 *Team* slice rather than more Phase-5 connectors.

The headline value is the **shared knowledge graph**. Slice 7 makes `data_model` / `dashboard` /
`data_quality_test` *graph-participating* (they are **not** today — see §4) and emits their pairwise
lineage edges, so the existing Phase-3 `traverseGraph` resolves the **Slice-7-owned sub-chain**
(Tableau→Snowflake, Looker→dbt-model, dashboard→data_model, dq→data_model) in **<500ms from the
local index with zero live API calls**. The full *Tableau→Looker→dbt→Snowflake→Airflow→PR* chain is
a **named stretch** — it additionally requires the dbt + Airflow connectors to become
graph-participating, which is out of this slice's scope (review finding F2).

**No new security invariant.** The write actions register in the existing HITL frozen set
(**I2/I3**); team-credentialed ops reuse the existing **I19** team-vault *machinery* via a local
adapter (designed in the plan — §5), not a literal call into the federated entry point. This slice is
"more connectors + graph edges," not a new gating mechanism — distinguishing it from 6b (I24) and
6c (I25).

### Non-goals (YAGNI)

- **No row data, ever.** Snowflake indexes column names + tags + row-count *estimates* + metadata —
  never cell values. This is a hard privacy line (roadmap: "strictly no row data").
- **No SQL query execution** surface. Snowflake `tasks`/`pipes` status is read; `warehouse.task.run`
  / `warehouse.pipe.resume` are the only Snowflake writes, both HITL-gated.
- **No new item types and no item-shape migration** — `data_model` / `dashboard` /
  `data_quality_test` already exist (used by Metabase/Superset/data-profile/great-expectations
  mappings). The only schema change is seeding new graph relation types (Wave 7a, V40).
- **No SAML** (Slice 3 deferred it); these connectors use OIDC/OAuth/Key-Pair/API-token per vendor.
- **No Data-FinOps cost attribution** (roadmap line 1354) — that's a downstream Phase-10 stretch
  built *on top of* these connectors, explicitly out of scope here.
- **No new traversal engine** — lineage is edge-emission only; `traverseGraph` already exists.

---

## 2. Scope & wave sequencing

One spec, one implementation plan, delivered as **three reviewable waves** (separate PRs), matching
the "connectors in one big PR, my discretion on order" cadence while keeping the novel engine work
small and reviewable:

| Wave | Deliverable | New invariant? | Migration? |
|------|-------------|----------------|------------|
| **7a** | 6 read-only connectors (personal-auth) indexing items **+ 3 new graph-populator handlers + pairwise lineage edges**; the `<500ms` Slice-7-owned sub-chain acceptance test | no | **V40** (seed graph relation types) + a code-constant change (extend graph entity types) |
| **7b** | Team-Vault shared-credential **opt-in** path for these connectors (via existing I19) | no (reuses I19) | no |
| **7c** | 7 HITL write actions, registered + wired behind the existing HITL gate | no (reuses I2/I3) | no |

Each wave is independently shippable and leaves the tree green. 7a delivers the bulk of the value
(indexing + lineage); 7b and 7c layer on the team-credential and write surfaces.

---

## 3. Connector architecture & item mapping

Each connector follows the established first-party MCP pattern:

- Package at `packages/mcp-connectors/<name>/`, depending on `@nimbus-dev/sdk` only.
- `Syncable` sync handler using the shared `_lib/fetch-outcome.ts` (`connectorFetch` — rate-limit +
  fetch + bytes + parse) and `syncPassCursor*` paging helpers.
- `runReadOnlyMcpConnector` bootstrap (`mcp-connectors/shared/`) for the read-only tool surface;
  Wave 7c adds the write tools to the connectors that have them.
- Registry wiring: `CONNECTOR_VAULT_SECRET_KEYS` entry in `connector-secrets-manifest.ts`, connector
  catalog entry, rate-limiter entry — all landing **with** the sync handler (typecheck couples them;
  `bun test` alone hides the `tsc` failure — see the connector-plan-wiring coupling note).
- Public-tier README H2 sections (enforced by `audit:package-readmes`, not `test:ci`).
- CHANGELOG entry per connector (the post-#421 convention); **do not** touch the CLAUDE.md/GEMINI.md
  status line.

**Reuses existing item types — no new types, no item-shape migration:**

| Connector | Item type(s) | Auth modes | Indexed fields (read-only) |
|-----------|--------------|------------|----------------------------|
| **Snowflake** | `data_model` | SSO / OAuth / Key-Pair | databases, schemas, tables/views (**column names + tags only**), tasks, pipe status, recent query-history *metadata*, row-count *estimate*, last-altered — **no row data** |
| **Tableau** (Server/Cloud) | `dashboard` | Personal-auth (PAT / connected-app) | dashboards, reports, views, workbooks, authors, folders, extract-refresh status |
| **Looker** | `dashboard` + `data_model` | Personal-auth (API3 key) | dashboards, Looks, Explores, LookML models, content folders |
| **PowerBI** | `dashboard` | Personal-auth (Entra/OAuth) | workspaces, reports, dashboards, datasets (**schema only**), dataflows |
| **Monte Carlo** | `data_quality_test` | SSO (API key/secret) | DQ incidents, freshness alerts, schema-change logs, monitored tables, severity, first-seen-at |
| **Bigeye** | `data_quality_test` | SSO (API key) | DQ metrics, SLA breaches, monitored schemas, anomaly records |

Item ID format follows the existing connector convention (`<service>:<stable-external-id>`); the
exact key per connector is fixed in the plan against the connector-authoring skill.

---

## 4. Lineage edges (the headline value)

Lineage is **edge-emission during sync**, traversed at query time by the existing Phase-3
`traverseGraph` BFS (`graph/relationship-graph.ts`). **Three** concrete gaps in the current graph
layer must be closed — and the third (the populator handlers) is real gateway work, not connector
boilerplate (review finding F1):

1. **Graph entity types.** `ITEM_LINKED_ENTITY_TYPES` (`relationship-graph.ts`) does **not** yet
   include `data_model`, `dashboard`, `data_quality_test`. These are added to the constant so the
   items participate in the graph (and so `deleteGraphEntitiesForItemKeys` cleans them up on
   re-sync). Code change, not a migration (the `graph_entity.type` column is free-text).
2. **Populator handlers.** `syncGraphFromIndexedItem` (`graph/graph-populator.ts`) is a per-type
   dispatch with handlers for `pr / issue / message / git_commit / dependency / api_endpoint /
   code_symbol / obsidian_note` only — **no `data_model` / `dashboard` / `data_quality_test`
   handler exists**. Wave 7a adds three new functions — `syncDataModelGraph`, `syncDashboardGraph`,
   `syncDataQualityTestGraph` — that upsert the entity and emit the lineage edges below, registered
   in the dispatch. (This is the gap `agents/impact.ts` works around today with a
   `detectMissingEntityType(db, "dashboard")` gap-note.)
3. **Relation types.** `graph_relation_type` currently seeds only `depends_on`, `defined_in`,
   `in_repo` (`graph-relation-types-v12-sql.ts`). Wave 7a's **V40** migration seeds the lineage
   relation types via `INSERT OR IGNORE` (append-only, forward-only per the migration rules). The
   names **must be reconciled with what `traverseGraph` consumers already expect** — `agents/impact.ts`
   already summarizes an `… → upstream_refs → dashboard` path (review finding F4), so the plan
   verifies impact's queries before fixing the seed. Tentative vocabulary:
   - `upstream_refs` — `data_model` → `dashboard` (a table feeds a BI view; aligns with impact.ts)
   - `derived_from` — `data_model` → `data_model` (Looker view derived from a dbt model)
   - `monitors` — `data_quality_test` → `data_model` (a DQ monitor watches a table)

**Edges emitted per connector** (relation names pending the F4 reconciliation above):

| Edge | From → To | Source signal |
|------|-----------|---------------|
| Tableau view ← Snowflake table | `data_model`(Snowflake) `upstream_refs` `dashboard`(Tableau) | Tableau data-source connection metadata |
| Looker view → dbt model | `data_model`(Looker) `derived_from` `data_model`(dbt/GitHub) | LookML `sql_table_name` |
| Dashboard → underlying table | `data_model` `upstream_refs` `dashboard` | BI dataset/data-source metadata (Looker/PowerBI) |
| DQ monitor → table | `data_quality_test` `monitors` `data_model` | monitored-table reference |

**Canonical `data_model` edge key (the real design risk).** Snowflake names a table
`DB.SCHEMA.TABLE`; Looker's `sql_table_name`, Tableau's data-source caption, and dbt's
`database.schema.alias` each spell the same table differently (case, quoting, db/catalog prefix).
Cross-connector edges only compose if both ends resolve to one key. The plan defines a single
`normalizeDataModelKey()` helper (lower-cased, unquoted, `database.schema.table`, db/catalog
optional-and-stripped-when-absent) that **every** connector routes its `external_id` and edge
targets through. This helper + its table-name normalization tests are the highest-value unit work in
7a.

> **Scope boundary (review finding F2).** The existing dbt connector indexes `data_model` *items*,
> so Looker→dbt edges land against those existing item keys — but dbt `data_model`s and Airflow DAGs
> are **not graph-participating today** (same gap as the dashboard one impact.ts works around). The
> full *Tableau→Looker→dbt→Snowflake→Airflow→PR* chain therefore does **not** compose from
> already-shipped edges; it additionally needs dbt + Airflow graph participation. Slice 7 owns only
> the BI/warehouse hops (Tableau→Snowflake, Looker→dbt-model, dashboard→data_model, dq→data_model);
> the full 6-hop chain is a **named stretch / Phase-7 follow-up**, not a 7a exit criterion.

---

## 5. Credential model — personal default, team opt-in

- **Personal (default).** Each connector has its own key(s) in `CONNECTOR_VAULT_SECRET_KEYS`,
  resolved from the user's personal Vault exactly like the existing data-BI cluster. Works on a solo
  machine with no federation configured.
- **Team-shared (opt-in, Wave 7b).** A workspace may pin a shared service-account secret in Team
  Vault. The team-credential path reuses the **I19 machinery** — identity → grant → quorum →
  secret-injected-inside-the-runTool-callback, leak-proof result, fail-closed on missing secret,
  sandboxed (I15). No new invariant.

  > **Review finding F3 — not a drop-in.** `answerFederatedInvoke` (`federation/invoke-gate.ts`)
  > takes an `InboundInvoke { peerId, … }` and resolves a **per-peer** RBAC grant — it is built for
  > an *inbound peer* consuming a team tool. A *local* connector sourcing a team secret has no peer
  > and no per-peer grant. Wave 7b therefore introduces a **local-operator adapter** that feeds the
  > same identity→grant→quorum→inject machinery from a local caller (a local-operator principal
  > rather than a wire peer). The exact adapter shape — reuse `answerFederatedInvoke` with a synthetic
  > local principal vs. a thin local sibling that shares its internals — is a **plan open-item**. Either
  > way it stays a *consumer* of the I19 gate, not a new gate, so the invariant count is unchanged.

The selection (personal vs team) is config-driven per connector (`[connectors.<name>].credential =
"personal" | "team"`); when `team`, the secret is never materialized into the connector config — it's
injected ephemerally by the I19 machinery, same as Slice 2/5.

---

## 6. HITL write actions (Wave 7c)

Seven write actions, each registering in the HITL frozen set (`HITL_REQUIRED_BACKING`, **I2**) and
gated by the executor's consent gate (which consults `action.type` only, **I3**) before the
connector is called:

| Action type | Connector | Effect |
|-------------|-----------|--------|
| `warehouse.task.run` | Snowflake | resume/execute a task |
| `warehouse.pipe.resume` | Snowflake | resume a pipe |
| `bi.comment.post` | Tableau | post a comment on a view |
| `bi.schedule.send` | Looker | trigger a scheduled-content send |
| `bi.dataset.refresh` | PowerBI | trigger a dataset refresh |
| `dq.incident.resolve` | Monte Carlo | resolve an incident |
| `dq.sla.acknowledge` | Bigeye | acknowledge an SLA breach |

Each write tool is declared HITL in the connector manifest. A per-action HITL test proves the gate
fires **before** the connector op runs (the testing-philosophy requirement). When the underlying
credential is team-shared, the write additionally rides the I19 path from §5.

---

## 7. Schema & config

- **V40 migration** (Wave 7a only): seed `upstream_refs` / `derived_from` / `monitors` into
  `graph_relation_type` (`INSERT OR IGNORE`). No new tables, no column adds — the lightest possible
  migration. New `runner-v40.test.ts` per the db-migrations skill.
- **Code constant:** extend `ITEM_LINKED_ENTITY_TYPES` with `data_model`, `dashboard`,
  `data_quality_test`.
- **Graph populator (gateway work):** three new handlers in `graph/graph-populator.ts`
  (`syncDataModelGraph`, `syncDashboardGraph`, `syncDataQualityTestGraph`) + their dispatch
  registration + unit tests. This is the real engine work behind the lineage (review finding F1).
- **nimbus.toml:** `[connectors.snowflake]` … `[connectors.bigeye]` sections (host/account, auth
  mode, `credential = "personal"|"team"`); validated in `config/nimbus-toml.ts`.
- **No IPC namespace change** — these connectors are reached through the existing connector
  sync/registry and the existing HITL/action IPC; no new `*-rpc.ts` surface, so no Tauri allowlist
  change.

---

## 8. Testing & acceptance

Per the Nimbus testing philosophy:

- **Connector contract tests** — mock MCP servers, fresh temp dirs, **no live cloud** (the
  `connector-sync-test-helpers` + `linear-sync.test.ts` exemplar). Now-relative fixtures, never
  hardcoded dates (the fixture date-rollover trap).
- **Lineage integration test** — real SQLite, seeded multi-connector fixtures, asserting the
  **Slice-7-owned sub-chain** (Tableau→Snowflake, Looker→dbt-model-item, dashboard→data_model,
  dq→data_model) resolves via `traverseGraph` in **<500ms** with **zero** live API calls. This is the
  Slice-7 flagship exit criterion. A separate **skipped/stretch** test documents the full 6-hop chain
  and is unskipped only once dbt + Airflow graph participation lands (review finding F2).
- **`normalizeDataModelKey()` unit tests** — the cross-connector key normalization (case, quoting,
  db-prefix variants) that the lineage edges depend on.
- **HITL tests** (Wave 7c) — gate-fires-before-connector for each of the 7 write action types.
- **Team-Vault tests** (Wave 7b) — no shared secret value escapes through any interface (the Vault
  no-leak standard); fail-closed on missing secret.
- **Coverage gates** — connectors ≥80% branch+line (the Sub-project-B floor, CI-Linux-authoritative
  via `audit:coverage-floor`). New gateway-side files (graph constant, normalizer, V40) clear the
  same floor.

### Acceptance criteria (slice exit)

1. All 6 connectors index their items into the existing item types; **no row data** is ever
   persisted (asserted by a Snowflake test that inspects a populated table item for absence of cell
   values).
2. The Slice-7-owned lineage sub-chain (Tableau→Snowflake, Looker→dbt-model, dashboard→data_model,
   dq→data_model) resolves in <500ms from the local index with no live API call. (The full 6-hop
   cross-warehouse chain is a named stretch — it depends on dbt + Airflow graph participation, out of
   scope here.)
3. Each of the 7 write actions is HITL-gated (gate fires before the connector op).
4. A connector configured `credential = "team"` sources its secret only via the I19 machinery (the
   local-operator adapter of §5) and fails closed when the team secret is absent; the secret never
   appears in config, logs, or IPC.
5. Full `bun run preflight` green on the 3-OS matrix; the security-invariants test count is
   **unchanged** (no new invariant).

---

## 9. Open items to resolve in the plan (not blockers)

- Per-connector pagination + rate-limit specifics (Snowflake's `INFORMATION_SCHEMA` vs the SQL API;
  Tableau REST vs Metadata API; PowerBI admin-vs-user scope) — fixed against each vendor's API in the
  plan, against the connector-authoring skill.
- Whether Looker→dbt edges should match dbt items by `sql_table_name` directly or via the
  normalized key from §4 (lean: normalized key, single code path).
- Exact `credential` injection seam reuse from Slice 5 (`NIMBUS_*_E2E_SINK_DIR`-style seams) for the
  team-credential e2e test without a live warehouse.
- **(F3)** The local-operator adapter shape for the I19 machinery: reuse `answerFederatedInvoke` with
  a synthetic local principal, or a thin local sibling sharing its internals. Decide before Wave 7b.
- **(F4)** Verify `agents/impact.ts` (and any other `traverseGraph` consumer) query the relation-type
  names the V40 seed will use, before finalizing the seed (`upstream_refs` is the tentative match).
- **(F6)** Snowflake Key-Pair auth stores a PEM private key (not a token) in Vault — confirm Vault
  value-size handling + the connector's key-loading path.
- **(F7)** Confirm the 7 write actions need no new `*-rpc.ts` entry point or Tauri-allowlist change to
  be triggered from the CLI (they should ride the existing engine/executor action path).
