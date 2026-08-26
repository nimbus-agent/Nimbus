---
name: nimbus-data-warehouse-lineage
description: >
  Phase 6 Slice 7 (Wave 7a) data-warehouse / BI connectors and the cross-warehouse
  lineage graph: the six read-only connectors (Snowflake, Tableau, Looker, Power BI,
  Monte Carlo, Bigeye), the `data_model` / `dashboard` / `data_quality_test` item types,
  the metadata-only ("no cell values") contract, the V40 `graph_relation_type` lineage
  edges (`derived_from` / `upstream_refs` / `monitors`), the `normalizeDataModelKey`
  convergence helper, the three graph populators, and the ~6 type-coupled registration
  sites a new warehouse/BI connector must touch. Use when adding or modifying a warehouse
  or BI connector, wiring a new lineage edge type, debugging why a dashboard/test doesn't
  link to its upstream table, or asking why `nimbus impact` doesn't cross the warehouse
  boundary. Pairs with `nimbus-connector-authoring` (connector mechanics) and
  `nimbus-db-migrations` (the V40 migration).
---

# Data-Warehouse / BI Connectors + Cross-Warehouse Lineage (Phase 6 Slice 7, Wave 7a)

Shipped 2026-06-13 (PR #595, schema **V40**). Six **read-only, metadata-only** connectors feed a shared lineage graph so a single warehouse table is one graph node no matter which BI tool references it — enabling `nimbus impact` / `nimbus ask` to trace *dashboard → model → warehouse table → data-quality monitor* across tools.

Read `nimbus-connector-authoring` first for the generic connector contract; this skill covers only the warehouse/BI-specific shape.

## The six connectors

| Connector (catalog id) | Emits item type(s) | Lineage metadata it writes | Vault keys |
| --- | --- | --- | --- |
| `snowflake` | `data_model` | `dataModelKey`, `columns` (name+tag, **no values**), `rowCountEstimate`, `lastAltered` | `snowflake.account`, `snowflake.oauth_token`, `snowflake.key_pair_jwt` |
| `tableau` | `dashboard` | `upstreamDataModelKeys[]` | `tableau.url`, `tableau.pat_name`, `tableau.pat_secret` |
| `looker` | `dashboard` + `data_model` (LookML views) | dashboard: `upstreamDataModelKeys[]`; view: `dataModelKey`, `derivedFromKeys[]` (the `sql_table_name`) | `looker.base_url`, `looker.client_id`, `looker.client_secret` |
| `powerbi` | `dashboard` | `upstreamDataModelKeys[]` | `powerbi.tenant_id`, `powerbi.client_id`, `powerbi.client_secret` |
| `montecarlo` | `data_quality_test` | `monitoredDataModelKeys[]`, `status`, `severity` | `montecarlo.api_id`, `montecarlo.api_token` |
| `bigeye` | `data_quality_test` | `monitoredDataModelKeys[]`, `slaStatus`, `anomaly` | `bigeye.base_url`, `bigeye.api_key` |

These MCP servers are **live** (real APIs), not stubs. Per-connector files:
`connectors/<name>/src/server.ts` in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) (MCP surface), `packages/gateway/src/connectors/<name>-sync.ts` (sync handler), `packages/gateway/src/connectors/<name>-{data-model,dashboard,dq}-mapping.ts` (item mapper).

## The metadata-only ("no-row-data") contract

Warehouse/BI connectors index **schema and aggregate metadata only** — table/column names, column tags, row-count *estimates*, refresh status, DQ verdicts — **never cell values, query results, or report data**. This is the same locality guarantee as the Tier-3 "no-row-data" warehouse connectors (BigQuery/Athena/etc.; see `nimbus-file-map` for `assertNoRowDataTools`). For these six, the contract is enforced by:

1. **Mapper design** — e.g. `snowflake-data-model-mapping.ts` stores `columns` (name + tag) + `rowCountEstimate` + `lastAltered`, nothing row-shaped.
2. **Per-mapper unit tests** — each `*-mapping.test.ts` asserts the mapped item carries "**no cell values**".
3. **MCP server queries** — `information_schema` / metadata-API calls only; no `SELECT *` / data fetches.

When adding a warehouse/BI connector, add a mapper test that asserts the absence of any row/cell field, and keep the MCP tool surface free of any row-fetch tool.

## The lineage graph (V40)

`packages/gateway/src/index/graph-lineage-types-v40-sql.ts` seeds three **directed** `graph_relation_type` rows:

| Edge type | Direction | Created from |
| --- | --- | --- |
| `derived_from` | `data_model → upstream data_model` | a view's `derivedFromKeys` (e.g. a Looker view → its dbt/warehouse table) |
| `upstream_refs` | `data_model → dashboard` | a dashboard's `upstreamDataModelKeys` (e.g. Snowflake table → Tableau/Power BI dashboard) |
| `monitors` | `data_quality_test → data_model` | a test's `monitoredDataModelKeys` (e.g. Monte Carlo / Bigeye → the monitored table) |

**Key convergence — the heart of cross-warehouse lineage.** Every connector routes its table identifiers through `normalizeDataModelKey(raw)` in `packages/gateway/src/connectors/data-model-key.ts` (strips quotes/brackets, lower-cases, dot-joins; returns `null` if nothing usable survives). Tableau's `upstreamDataModelKeys`, Looker's `derivedFromKeys`, and Monte Carlo's `monitoredDataModelKeys` must all normalize to the **same** canonical key (e.g. `analytics.public.revenue`) as Snowflake's `dataModelKey` — otherwise the edge points at a phantom node and the graph silently fails to connect. When a link is missing, check normalization first.

**Populators** — `packages/gateway/src/graph/graph-populator.ts`:
`syncDataModelGraph` (`derived_from`), `syncDashboardGraph` (`upstream_refs`), `syncDataQualityTestGraph` (`monitors`), dispatched by `syncGraphFromIndexedItem` on `row.type`.

## The ~6 type-coupled registration sites

A new warehouse/BI connector must land all of these in one PR (a `bun test` pass will hide a missing `tsc`-only site — see `nimbus-connector-authoring`):

1. `packages/gateway/src/connectors/connector-catalog.ts` — add the catalog id.
2. `packages/gateway/src/connectors/connector-secrets-manifest.ts` — add the `CONNECTOR_VAULT_SECRET_KEYS` entry (gates the static vault-key allow-list audit).
3. `packages/gateway/src/platform/assemble-sync-registrations.ts` — `syncScheduler.register(create<Name>Syncable({...}))`.
4. `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts` — `phase3Add<Name>Mcp(...)` (spawns the MCP server when its creds are present).
5. `packages/gateway/src/graph/relationship-graph.ts` — `ITEM_LINKED_ENTITY_TYPES` must include the item type(s) you emit (`data_model` / `dashboard` / `data_quality_test` already present).
6. `packages/gateway/src/graph/graph-populator.ts` — only if you introduce a **new** item type / edge type; the three existing types already dispatch.

New item type → also a V-migration if it needs new graph relation types (see `nimbus-db-migrations`); reusing `data_model` / `dashboard` / `data_quality_test` needs no schema change.

## Roadmap note

Wave 7a is read-only. Wave 7b (team-vault-gated access, I19) and Wave 7c (HITL-gated writes) are separate, later slices — keep new warehouse work read-only unless you are explicitly implementing 7b/7c.
