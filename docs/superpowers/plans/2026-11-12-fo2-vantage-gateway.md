# Plan — FinOps FO2: the Vantage gateway side (contract, mapper, syncable, retention, embedding exclusion, pin bump)

Status: DRAFT plan for Antigravity review (round 2).
Spec: `docs/superpowers/specs/2026-11-12-finops-connectors.md` (APPROVED, round 2): § 2 (OR-FO-1..5, D-FO-1..12),
§ 5.1 (the contract), § 5.2 (the FO2 row), § 5.3 (Vantage, gateway half), § 6, § 7, § 8.
Companion: `docs/superpowers/plans/2026-11-12-fo1-vantage-connector.md` (the connectors half, implemented as
nimbus-mcp-servers #85, to be released as `@nimbus-dev/connectors` 0.14.0).
Roadmap row: Phase 10 stretch *FinOps connectors* (`docs/roadmap.md`, the row starting "**FinOps connectors**").
FO2 adds no HITL type, no egress class, no `ALLOWED_METHODS` entry, no IPC method, no CLI command, no model step,
no invariant, and (decided below) no schema migration.

After FO2: with `vantage.api_token` in the Vault, a scheduled sync (every 6 h) spawns the sandboxed Vantage
connector, drains `vantage_cost_list` and `vantage_recommendation_list`, and indexes `vantage:cost_allocation` rows
(one per series per UTC day, at most 500 series, the tail folded into `__other__`) and `vantage:cost_recommendation`
rows; cost rows are never embedded; a pure reader `readCostSeries` returns a daily series with provisional days and
gaps; a daily pass deletes cost rows past `[finops] retain_days` (400).

## Spec deviations (each checked against the code at `origin/main` `6fa8612d2`; the correction binding for FO2)

1. **The contract, rollup, reader and retention live in `packages/gateway/src/finops/`, not `connectors/finops/`.**
   Spec § 5.1 names `connectors/finops/cost-item-contract.ts` and `finops/cost-series.ts` in one breath. The static
   rule below (D4x) confines a directory to "no network, no connector dispatch, no model"; putting the pure code in
   one directory makes that rule one path prefix. The mapper and the syncable stay in `connectors/` beside
   `monte-carlo-sync.ts` and `ramp-transaction-mapping.ts`.
2. **No index read is available to a syncable, so D-FO-5's "watermark read from the index" becomes a cursor.**
   `SyncContext` has no `db` (`sync/types.ts:28` extends `SyncCapabilities`; `sync/sync-capabilities.ts:81` lists what a
   syncable may touch: `countItems`, `itemMetadata`, `listIndexedMetadataValues` (`:132`), `deleteItem`, no query).
   Correction: `SyncResult.cursor` carries `{ lastOkMs }` (prefix `nimbus-vantage1:`, via `encodeNimbusJsonCursor`,
   `connectors/nimbus-json-cursor.ts`), and `sinceMs = startOfUtcDay(lastOkMs) - 3 days`; no cursor means
   `now - 45 days`. The reason D-FO-5 gave (stable ids make a re-read an idempotent upsert) still holds. The
   scheduler persists the cursor in `sync_state`, which `commands/data-delete.ts:29` clears with the rows, so a wiped
   index re-reads 45 days. A cursor lost with the rows kept is also safe (a re-read of 45 days upserts the same ids).
3. **The 500-series cap cannot rank by "trailing 30-day amount" on an incremental fetch.** An incremental sync sees
   only 3 to 4 days, so a daily re-ranking would move series in and out of `__other__` and tear their history.
   Correction (a stable named set): the first sync (45 days of rows) names the top 500 by the window total; every later
   sync keeps the series already indexed (the distinct `seriesHash` values of the service's rows, read with
   `ctx.listIndexedMetadataValues("vantage", "seriesHash")`) and lets a NEW series join only while the named set is
   under the cap; everything else folds into that day's `__other__` row. A series never leaves the named set
   until retention deletes its last row. Stated bound: a series that begins after the cap is full is invisible by
   name until another series ages out.
4. **Embedding exclusion has seven sites, not two (D-FO-10 named two).** Verified: (a) `index/item-store.ts:222-225`
   `upsertIndexedItemForSync` calls `ctx.scheduleItemEmbedding?.(id)`; (b) `embedding/lazy-scheduler.ts:170`
   `scheduleItemEmbedding` re-reads the row and calls `embedItem`; (c) `embedding/pipeline.ts:197`
   `backfillAll` has a COUNT (`:201`) and a SELECT (`:222`); (d) `backfillForRoutingKeys` (`:238`) has a COUNT (`:256`)
   and a SELECT (`:275`); (e) `ipc/index-reembed-rpc.ts` `buildCandidateSql` (`:109`); (f) `db/index-health.ts`
   `readPerService` (`:96`) counts every item as embeddable, so cost rows would show as permanently un-embedded.
   **The exclusion must be in the SELECT/COUNT, not in `embedItem` (`pipeline.ts:103`)**: an `embedItem` that skips
   writes no chunk, and `backfillAll`'s `while (true)` re-selects "items with no chunk" forever (`:211-235`).
5. **`OPTIONAL_SECRET_KEYS` matters for a different reason than the review of the spec said.** `isConnectorConfigured`
   (`sync/connector-configured.ts`, the final function) is "ANY key of `requiredSecretKeysFor(serviceId)` is non-blank",
   not "all keys". `requiredSecretKeysFor` (`connectors/connector-secrets-manifest.ts:245`) is the manifest list minus
   `OPTIONAL_SECRET_KEYS` (`:242`, today only `github.api_base`). Without the entry, a lone `vantage.group_by` makes
   the connector "configured": the scheduler appends one `sync` egress row per run and the syncable makes no request
   (the documented I29 bound in the comment above `isConnectorConfigured`). With it, only `vantage.api_token` counts.
   The same list is the I19 team presence check (`teamvault/team-tool-invoke.ts:62`), unused here (D-FO-7).
6. **`audit:connector-version-skew` does not fail a pin that is ahead of the registry** (its header comment in
   `scripts/structure-audit/check-connector-version-skew.ts`: "Ahead-of-registry is `ok`"). The real gate is
   `bun install`: it cannot resolve `^0.14.0` until the npm publish, and `bun.lock` must change with
   `packages/gateway/package.json:21` (run `bun install`; never hand-edit the lockfile). FO2's catalog id, registry line and tests therefore wait for
   the publish (ordering below).
7. **A new transport, not an edit of `createWarehouseListSyncable`.** The warehouse transport
   (`connectors/warehouse-sync-transport.ts:73`) drains with fixed `{ cursor, limit }` arguments
   (`connectors/connector-list-page.ts` `drainPagedList`) and is tied to `TEAM_CREDENTIAL_SYNC_CONNECTORS` by
   `isWarehouseListSyncable`. FO2 adds `connectors/finops-sync-transport.ts` that passes `sinceMs`/`untilMs` and
   refuses a team pin (D-FO-7); the warehouse transport is untouched.
8. **Category "cloud".** `ConnectorCategory` (`catalog/connector-catalog-meta.ts:14`) is presentation only
   (`catalog/catalog-list.ts` passes it through). "finance" holds payment products (Stripe, Ramp, Mercury); cloud-cost
   products are cloud spend. No new enum value; a dedicated category is later presentation work.
9. **Contract additions to spec § 5.1** (additive, declared in `finops/cost-item-contract.ts`): `seriesHash`
   (the 16-hex hash used in the id, needed by deviation 3), `groupings` (the grouping names as sent, in order),
   `rowCount` (how many vendor rows were summed into this row: 1 for a named series, n for `__other__`).
10. **Unverified row shape (spec R2) drives the mapper.** The documented example row has `accrued_at`, `amount`,
    `currency`, `provider`, `account_id`, `service` (FO1 plan, § 2). Where a `tag:` grouping's value is returned is
    unverified. The mapper reads dimension fields by a fixed rule (Task 2) and Task 0 closes R2 from the OpenAPI
    file; if the file does not say, tag groupings are refused in v1 and the README and the roadmap row say so.
11. **No migration (decided).** The `item` table holds an arbitrary `type` and JSON `metadata` (`index/item-store.ts:65`
    writes `service, type, external_id, title, body*, url, canonical_url, resolve_key, modified_at, author_id, metadata,
    synced_at, pinned`; no CHECK on `type`, indexes `idx_item_service`, `idx_item_type`, `idx_item_modified_at` from
    `index/unified-item-v3-sql.ts:33-35` and `(service, type, modified_at, id)` from `source-catchup-v74-sql.ts:26`).
    The reader's `json_extract(metadata,'$.seriesKey')` predicate scans one service's `cost_allocation` rows (at most
    about 22,500 on first sync, then 500 per day, bounded by retention) behind the `(service, type, ...)` index; measured
    in Task 3. If that proves slow, a follow-up migration takes "V9x (next free at merge)" (IC1 holds V94, FS1 V95);
    FO2 does not.
12. **Retention is a daily sidecar through `deleteItemByPrimaryKey`, not a step of the sync.** Spec D-FO-9 says retention
    runs "through the existing delete chokepoint (`deleteItemByServiceExternal`) after a successful sync only". A
    `SyncContext` cannot list or query rows (deviation 2), so retention cannot run inside `sync()`; it follows
    `startCuSnapshotRetention` (`computer-use/cu-snapshot-retention.ts`) with its own `db`, and deletes through
    `deleteItemByPrimaryKey` (`item-store.ts:263`, the function `deleteItemByServiceExternal` itself calls). Effect: rows
    are pruned within 24 h of aging out, independent of whether a sync succeeded that day.
13. **No CLI or IPC change.** `nimbus connector auth <service>` prints the exact Vault keys for a connector with no
    auth flow (`packages/cli/src/commands/connector.ts`, the note beginning "Most other token / API-key connectors");
    Vantage joins them through the catalog auth hint. Credentials are stored with `nimbus vault set vantage.api_token`.

Spec claims verified correct (the numbering above is 1 to 13): `scheduleItemEmbedding` is optional on `UpsertSyncDeps` (`item-store.ts:218`); deletion
goes through `deleteItemByPrimaryKey` (`:263`) / `deleteItemByServiceExternal` (`:274`); the config pattern for a
section is `loadTomlSectionFromConfig` (`config/nimbus-toml.ts:74`) with `SECTION_LOADERS` (`config/config-explain.ts:80`);
the session transport is `withConnectorSession` (`teamvault/connector-session.ts`) with `__setSessionSpawnerForTest`
(`:84`); retention is started like `startCuSnapshotRetention` (`platform/assemble.ts:4624`).

## Design decisions

**Files.** New (`packages/gateway/src/`):
- `finops/cost-item-contract.ts` (+ test): types, `COST_ALLOCATION_TYPE`, `COST_RECOMMENDATION_TYPE`,
  `seriesHashOf`, `costRowExternalId`, `isCostItemType`, `RESTATE_WINDOW_DAYS = 3`, `FIRST_WINDOW_DAYS = 45`.
- `finops/cost-rollup.ts` (+ test): fold to the named set and `__other__`, `finalized` rule.
- `finops/cost-series.ts` (+ test): `readCostSeries`.
- `finops/cost-retention.ts` (+ test): `pruneCostRows`, `startFinopsRetention`.
- `config/finops-toml.ts` (+ test): `[finops] max_series`, `retain_days`.
- `embedding/embedding-exclusions.ts` (+ test): `EMBEDDING_EXCLUDED_TYPES`, `isEmbeddingExcludedType`, `notEmbeddingExcludedSql`.
- `connectors/vantage-cost-mapping.ts` (+ test): vendor row to a contract row, recommendation to an item.
- `connectors/finops-sync-transport.ts` (+ test): the `sinceMs` drain and `createFinopsSyncable`.
- `connectors/vantage-sync.ts` (+ test): `createVantageSyncable`.
- `connectors/lazy-mesh/phase3-finops.ts`: `phase3AddVantageMcp` (tested in `phase3-config.test.ts`).
- `packages/gateway/test/integration/finops/vantage.acceptance.test.ts`.
Modified: `index/item-store.ts` (+ test), `embedding/pipeline.ts` (+ test), `embedding/lazy-scheduler.ts`,
`ipc/index-reembed-rpc.ts` (+ test), `db/index-health.ts` (+ test), `connectors/connector-catalog.ts`,
`catalog/connector-catalog-meta.ts`, `connectors/connector-secrets-manifest.ts` (+ tests), `sync/rate-limiter.ts`,
`connectors/lazy-mesh/{first-party-manifests,phase3-config,mesh}.ts` (+ tests), `platform/assemble-sync-registrations.ts`
(+ test), `platform/assemble.ts`, `config/config-explain.ts`, `connectors/bundled-connector-registry.ts` (generated),
`connectors/connector-writes/manifest.generated.ts` (regenerated, expected no row change),
`scripts/structure-audit/check-nimbus-invariants.ts` (+ test), `docs/structure-audit/index-lane-census.json`,
`packages/gateway/package.json`, `bun.lock`, and the docs in Task 14.

**The contract (`finops/cost-item-contract.ts`).** `seriesKey` and the id follow spec D-FO-3 and § 5.1:
`externalId = "<scopeId>:<seriesHash>:<YYYY-MM-DD>"`, `scopeId` = the cost-report token or `default`, sanitised to
`[A-Za-z0-9_-]` (anything else is replaced by the first 12 hex of its SHA-256), `seriesHash` = first 16 hex of
SHA-256 over `dimensionKind|dimensionKey|dimensionValue` after escaping `|` in each part. `modifiedAt` =
`min(periodEndMs, syncedAt)`. `title` = `"<dimensionValue> <YYYY-MM-DD> <amount> <currency>"` truncated to 200
characters. `amount` is a finite JSON number; a vendor amount that is a numeric string is accepted, anything else
drops the row (counted, never logged by value). `finalized = periodEndMs <= syncedAt - 3 days`.

**The mapper's dimension rule (deviation 10).** For a vendor cost row: the metric fields are `accrued_at`, `amount`,
`currency` (and `total_cost`-style siblings); every other scalar string field is a dimension, in the order of
`vantage.group_by` when set, else the row's own key order sorted. Names map to kinds: `account_id` and
`billing_account_id` to `account`, `service` to `service`, `provider` to `provider`, `cost_category` and
`cost_subcategory` to `cost_category`, `tag:<k>` (or a `tags` object entry) to `tag` with `dimensionKey = k`, anything
else to `other`. `dimensionKind`/`Key` come from the FIRST dimension; `dimensionValue` is all dimension values
joined with ` / ` (a `/` inside a value is written `%2F`); `groupings` lists the names. A row with no dimension
field at all is a single series with `dimensionKind: "other"`, value `total`.

**Sync (`createFinopsSyncable`).** `defaultIntervalMs` = `HOUR6` (the constant exists at `connector-catalog.ts:135`),
`initialSyncDepthDays` 45. `sync(ctx, cursor)`: (1) `credentialFor("vantage")` pinned to `team` throws an actionable
error naming D-FO-7; (2) read `lastOkMs` from the cursor; (3) one `withConnectorSession` (one spawn per cycle, the D9
primitive): drain `vantage_cost_list` with `{ sinceMs, untilMs: now, limit: 5000 }` following `nextCursor` to the end,
then `vantage_recommendation_list` with `{ limit: 1000, cursor }` ONLY (its schema is `cursorListInputSchema(1000)`,
`connectors/vantage/src/tools.ts` on the connectors `main` at the 0.14.0 release: a `limit` above 1000 fails Zod validation and would
abort the whole sync; it takes no `sinceMs`/`untilMs`), following `nextCursor` to the end; ALL drains finish before any write, so a failed or rate-limited drain
indexes nothing and leaves the cursor unchanged; (4) map, roll up to the named set (deviation 3), upsert in one
`ctx.writeBatch`; (5) return `{ cursor: lastOkMs = syncedAt, hasMore: false }`. Item depth is `metadata_only`
(`bodyPreview` = the title; nothing else is stored).

**Retention (`finops/cost-retention.ts`).** `pruneCostRows(db, { retainDays, nowMs, batch = 1000 })` selects
`id` where `type = 'cost_allocation'` and `json_extract(metadata,'$.periodEndMs') < cutoff` and deletes each through
`deleteItemByPrimaryKey` (`item-store.ts:263`: graph cleanup and the IC1 `__deleted` hook stay on one path; static
D12 still holds because that function uses `dbRun`), a batch per transaction, until none remain. `startFinopsRetention`
mirrors `startCuSnapshotRetention` (`computer-use/cu-snapshot-retention.ts`): one tick at boot, then every 24 h, errors
isolated, a stop handle pushed on `sidecarStops` beside `platform/assemble.ts:4624-4627`. `cost_recommendation` rows
are not pruned by age (a vendor archive is the bound in spec § 8).

**Static rule (name "D4x", next free at merge: IC1 holds D46, FS1 D47, so D48 if both land first).**
`finops-confined`, modeled on D45 (`scripts/structure-audit/check-nimbus-invariants.ts:2401-2430`): in every
non-test file under `packages/gateway/src/finops/` no import (static, dynamic, `require`, re-export) of `connectors/`
(a type-only import is allowed), `chatops/`, `egress/`, `federation/`, `share/`, `llm/`, `engine/` or `agents/`, and no
network primitive (`fetch` reference, `globalThis`, `Bun.fetch`, `WebSocket`, `node:http*`, `net`, `undici`). It makes
OR-10-8 and spec § 6 "unattended means inert" structural. No invariant is claimed (spec D-FO-11).

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions and the early research

1. Worktree: `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-fo2 -b dev/asaf/p10-fo2 main`
   (absolute path, never nested); verify `git rev-parse --abbrev-ref HEAD` before every commit. The spec and plans
   are STRIPPED before the PR (they never land on main).
2. `bun install`; on Windows `pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1`. Trust `bun run typecheck`
   over editor diagnostics in a fresh worktree.
3. Re-read, and write into the PR body: `CURRENT_SCHEMA_VERSION` (`index/local-index.ts:290`, 93 here; FO2 changes
   none), the D-rule ceiling (D45 here; IC1 D46, FS1 D47 in flight), the `@nimbus-dev/connectors` pin
   (`packages/gateway/package.json:21`, `^0.13.0`), and `npm view @nimbus-dev/connectors version` (the gate for
   Task 7).
4. Close spec R2/R5 from the vendor's OpenAPI file (`https://api.vantage.sh/v2/oas_v3.json`): where the value of a
   `tag:<k>` grouping appears in a cost row, whether `amount` is a number or a string, the format of `accrued_at`.
   Record the answers at the top of `connectors/vantage-cost-mapping.test.ts` (one line each, with the schema
   section). The fixtures for Tasks 2 and 12 are the connectors repo's `connectors/vantage/test/fixtures.ts` (FO1,
   branch `dev/asaf/fo1-vantage`), copied, not imported. If tag placement is undocumented: refuse a `tag:` entry in
   `vantage.group_by` at sync time with a fixed error and say so in the README/roadmap (deviation 10).

### Task 1 - The contract module

1. Test `finops/cost-item-contract.test.ts`: `seriesHashOf` is 16 lower-case hex and stable; two tuples that differ
   only in where a `|` falls hash differently (escaping); `costRowExternalId` is `<scope>:<hash>:<date>`; a scope with
   `/`, a space or a newline is replaced by a 12-hex hash and never appears raw; the id is at most 80 characters;
   `finalizedFor(periodEndMs, syncedAt)` is false inside 3 days and true on the boundary; `isCostItemType`.
2. Red, implement, green. Constants only; no I/O (the file is under the D4x scope).

### Task 2 - Mapper and rollup (pure)

1. Tests `connectors/vantage-cost-mapping.test.ts`: the documented example row maps to the contract keys; numeric
   string amounts are accepted and a non-finite amount drops the row; `accrued_at` as a date and as a datetime floor
   to the UTC day; the dimension rule (account, service, provider, tag, unknown, no-dimension rows); a 300-character
   dimension value is truncated with an ellipsis and a 6-hex hash suffix so two truncations do not collide; a row
   that is not an object is skipped; `modifiedAt` is capped at `syncedAt`; recommendations map the field list of
   spec § 5.0 [V4] (`potential_savings` string to a number), id = the vendor token.
2. Tests `finops/cost-rollup.test.ts`: the first sync names the top N series by window total (ties broken by
   `seriesKey`, deterministic); a later sync keeps an already-named series named even when it is small today; a new
   series joins only under the cap; the folded rows of one day sum into one `__other__` row with `rowCount`; the
   `__other__` series has its own stable `seriesHash`; `max_series` of 1 and of 500 behave; amounts are summed with
   no float drift beyond 1e-9 (sum in integer micro-units, convert once).
3. Red, implement (`connectors/vantage-cost-mapping.ts`, `finops/cost-rollup.ts`), green.

### Task 3 - The series reader

1. Test `finops/cost-series.test.ts` (real SQLite; rows written through the REAL mapper and `upsertIndexedItem`,
   never hand-built): a series with a missing day returns that day in `gaps`; `finalizedOnly: true` drops provisional
   days; `fromMs`/`toMs` bound the days; a different `seriesKey` is excluded; an `__other__` series is readable; the
   function opens no network (a source pin: the file has no `fetch`, no `globalThis`) and writes nothing (row counts
   and `PRAGMA data_version` are equal before and after). Time a 22,500-row table once and record the figure in the
   PR (deviation 11); if it exceeds 50 ms, add a pointer to the migration follow-up in the PR rather than a migration.
2. Red, implement `readCostSeries(db, { seriesKey, fromMs, toMs, finalizedOnly })` returning
   `{ points: { dayMs, amount, finalized }[], gaps: number[] }` with a bound-parameter query on
   `service`, `type = 'cost_allocation'` and `json_extract(metadata, '$.seriesKey') = ?` (I9: bound parameters; the
   service is parsed from the `seriesKey` prefix and validated against the five ids). Green.

### Task 4 - `[finops]` configuration

1. Test `config/finops-toml.test.ts`: defaults `max_series` 500 and `retain_days` 400; `max_series` outside `1..5000`
   or `retain_days` outside `30..3650`, or a non-integer, falls back to the default with a recorded section fallback
   (never clamped); an absent section is the defaults. `config/config-explain.test.ts` fails until the section is in
   `SECTION_LOADERS`.
2. Red, implement `config/finops-toml.ts` with `loadTomlSectionFromConfig` (`config/nimbus-toml.ts:74`) and the
   `intInRange` shape (`config/briefing-toml.ts:95`), register `finops` in `SECTION_LOADERS`
   (`config/config-explain.ts:80`). Green.

### Task 5 - Retention

1. Test `finops/cost-retention.test.ts`: rows older than `retain_days` are deleted and newer ones kept; a
   `cost_recommendation` row is never touched; a row of another service with the same `type` name is deleted only if
   it is a `cost_allocation` of one of the five ids (the query is by type AND service in the five ids); batches of 1000
   loop until empty (seed 2,500 rows); the delete goes through `deleteItemByPrimaryKey` (spy); a throwing prune is
   caught by `startFinopsRetention` and the next tick still runs; `retainDays` is injected, not read from disk.
2. Red, implement; wire `startFinopsRetention(db, { retainDays })` in `platform/assemble.ts` next to
   `:4624-4627`, reading `[finops]` from `paths.configDir`, and push its stop onto `sidecarStops`. Green.

### Task 6 - Embedding exclusion at all seven sites (deviation 4)

1. Tests first (all must be red before any production edit):
   - `embedding/embedding-exclusions.test.ts`: `isEmbeddingExcludedType("cost_allocation")` true; `cost_recommendation`,
     `incident`, `email` false; `notEmbeddingExcludedSql("i")` is the exact fragment `i.type NOT IN ('cost_allocation')`.
   - `index/item-store.test.ts`: `upsertIndexedItemForSync` with `scheduleItemEmbedding` as a spy calls it for a
     `pr` row and NEVER for a `cost_allocation` row.
   - `embedding/pipeline.test.ts` (real SQLite, fake embedder): with 3 `cost_allocation` and 2 `email` rows,
     `backfillAll` embeds exactly the 2 emails, terminates (a 5-second guard against the infinite loop of deviation
     4), and `onProgress` reports total 2; the same for `backfillForRoutingKeys` with `in` and with `notIn` scopes.
   - `ipc/index-reembed-rpc.test.ts`: `buildCandidateSql` never selects a cost row, with and without `service`/`itemType`
     filters, including `itemType = "cost_allocation"` (zero candidates, not an error).
   - `db/index-health.test.ts`: cost rows are excluded from `items` and `embedded` per service.
   - `embedding/lazy-scheduler.test.ts`: `scheduleItemEmbedding` on a cost row id never calls `embedItem`.
2. Implement `embedding/embedding-exclusions.ts`; apply it at `item-store.ts:224` (skip the call), `lazy-scheduler.ts:170`
   (return before `embedItem`), `pipeline.ts:201`, `:222`, `:256`, `:275` (AND the fragment), `index-reembed-rpc.ts:109`
   and `db/index-health.ts:101`. A comment at each site names the file, so a future excluded type is added in one
   place. Green; then revert each production edit once and watch its test fail (record in the PR).
3. Recommendations stay on the LOCAL embedder, by NOT adding them to `PROSE_HEAVY_TYPES` (`embedding/routing.ts`):
   `RoutingEmbeddingPipeline.embedItem` (`embedding/routing-pipeline.ts:16`) sends a prose-heavy item to the OpenAI embedder
   whenever `openai.api_key` is set, and a recommendation names accounts and services, which is cost data that must not
   leave the machine unattended (spec D-FO-10, § 6). A type absent from `PROSE_HEAVY_TYPES` is always MiniLM-384.
   `LOCAL_ONLY_PROSE_TYPES` is not used either: it is the explicit pin for paragraph-shaped types that also get the 16 KiB
   body store (`nimbus:web_clip`, captures), and a recommendation is short. Tests: `embedding/routing.test.ts` asserts
   `isProseHeavy("vantage","cost_recommendation")` and `isProseHeavy("vantage","cost_allocation")` are false (the file's
   existing exact-membership pin, "PROSE_HEAVY_TYPES exact membership (23 entries)", also fails if either is ever added);
   `embedding/routing-pipeline.test.ts` builds a `RoutingEmbeddingPipeline` with an OpenAI-configured stub embedder and a
   local stub, embeds a `vantage:cost_recommendation` item, and asserts the OpenAI stub received NO call and the local one
   exactly one (red-prove by temporarily adding the key to the set).

### Task 7 - GATE: the connector release, then the pin, the catalog id and the generated registry

Do not start this task before `npm view @nimbus-dev/connectors version` prints 0.14.0 (or the release FO1 produced).
Steps 2 and 3 are one commit: the catalog id without the registry line fails `audit:connector-registry-drift`, and
the registry line without the installed package fails `gen:connector-registry`.
1. Edit `packages/gateway/package.json:21` to `^0.14.0`; run `bun install` (it rewrites `bun.lock`; commit the result).
2. Add `"vantage"` to `CONNECTOR_SERVICE_IDS` (`connectors/connector-catalog.ts:3`, next
   to `"ramp"`), `vantage: HOUR6` to `CONNECTOR_SYNC_INTERVAL_MS` (`:137`), and the auth hint
   `vantage: "uses a Vantage API token (Read scope is enough)"` beside `dbt` (`:322`).
3. `bun run gen:connector-registry` (writes `connectors/bundled-connector-registry.ts`; expect exactly one added line
   `vantage: () => import("@nimbus-dev/connectors/vantage")`), `bun run gen:connector-write-manifest` (expect no change
   to any row: Vantage registers no write tool; if the file changes, read the diff, it is not FO2's), then
   `bun run audit:connector-registry-drift`, `bun run audit:connector-version-skew`, `bun run audit:connector-hosts`
   (the host `api.vantage.sh` must be declared in Task 8's manifest first, so run this audit after Task 8).
4. Everything keyed on `ConnectorServiceId` now fails `tsc` until Task 8; that is the intended red.

### Task 8 - Registration sites (one test per site)

1. `catalog/connector-catalog-meta.ts`: `vantage: m("Vantage", "cloud", "A cloud cost management and reporting platform")`
   beside `aws` (`:87`) (deviation 8). `connector-catalog-meta.test.ts` fails until present.
2. `connectors/connector-secrets-manifest.ts`: `vantage: ["vantage.api_token", "vantage.cost_report_token",
   "vantage.workspace_token", "vantage.group_by"]` and `OPTIONAL_SECRET_KEYS.vantage = ["vantage.cost_report_token",
   "vantage.workspace_token", "vantage.group_by"]` (`:242`). Tests (`connector-secrets-manifest.test.ts`,
   `sync/connector-configured.test.ts`): `requiredSecretKeysFor("vantage")` is `["vantage.api_token"]`; a Vault with ONLY
   `vantage.group_by` is NOT configured (red-prove by removing the OPTIONAL entry); a Vault with the token is;
   `clearConnectorVaultSecretKeys` clears all four; the vault-key allow-list audit knows the new keys.
3. `sync/rate-limiter.ts`: `"vantage"` in `Provider` (`:1`) and `vantage: { requestsPerMinute: 16, burstSize: 2 }` in
   `DEFAULT_QUOTAS` (`:93`; Vantage's documented 1,000 requests per hour is about 16 per minute, spec § 5.0 [V5]).
4. `connectors/lazy-mesh/first-party-manifests.ts`: `vantage: baseManifest("com.nimbus.vantage", { network:
   ["api.vantage.sh"], filesystem: { read: [], write: [] } })` beside `dbt` (`:301`); add `"vantage"` to the expected list
   in `first-party-manifests.test.ts` (~`:131`); assert no wildcard and no `ownerConfiguredNetwork` (I50 unchanged).
5. `connectors/lazy-mesh/phase3-finops.ts`: `phase3AddVantageMcp(vault, servers, sandboxCwd)` modeled on
   `phase3AddDbtMcp` (`phase3-data-bi.ts:18`): read `vantage.api_token` (empty or whitespace: register nothing); env
   `VANTAGE_API_TOKEN` plus the three optional keys only when non-empty, through `extensionProcessEnv` (I1);
   `wrapServerSpec({ ...connectorSpawn("vantage"), env }, manifestForFirstParty("vantage"), sandboxCwd)` (I15, D10).
   Wire it in `phase3-config.ts` (the import/re-export block near `:100-125` and `buildPhase3Servers` beside `:213`) and
   `lazy-mesh/mesh.ts` `PHASE3_LISTING_ADDERS` (`:143`, next to `montecarlo`). Tests in `phase3-config.test.ts` (pattern
   `:749-772`): no-op without the token; no-op with a whitespace token; spawns with `VANTAGE_API_TOKEN` set and
   `api.vantage.sh` in the sandboxed network list; the optional env vars appear only when stored; a token never appears
   in a log line.
6. `platform/assemble-sync-registrations.ts`: `syncScheduler.register(createVantageSyncable({ maxSeries }))` after
   `createBigeyeSyncable()` (`:563`); `ConnectorMeshSyncableOptions` (`:100-105`) gains an optional
   `finopsMaxSeries?: () => number`; `platform/assemble.ts:1103-1108` passes
   `() => loadNimbusFinopsFromConfigDir(paths.configDir).maxSeries`. Test in `assemble-sync-registrations.test.ts`.
7. `bun run typecheck` and `bun run typecheck:tests` green; then the host audit from Task 7 step 3.

### Task 9 - The transport and the Vantage syncable

1. Tests `connectors/finops-sync-transport.test.ts` (DI: an injected drain, as `__setPersonalDrainForTest` does for the
   warehouse transport; no subprocess): the cost drain passes `{ sinceMs, untilMs, limit: 5000, cursor }` and the recommendation drain passes exactly
   `{ limit: 1000, cursor }` (a test feeds the transport the REAL zod bounds: it builds the two schemas from the connectors
   package's own `connectors/vantage/src/tools.ts` registrar through the harness-style recorder, or, if the package's `src` is
   not importable under the gateway's rules, from a copy of the two `z.object` shapes pinned by a source-text assertion, and
   asserts both calls `safeParse` successfully and that `limit: 5000` on the recommendation tool does NOT); the drain follows
   `nextCursor` until null, and a mid-way throw rejects the whole drain; a `credentialFor` pin of `team` throws the
   D-FO-7 error before any spawn; `defaultIntervalMs` and `initialSyncDepthDays` are the declared ones.
2. Tests `connectors/vantage-sync.test.ts` (real SQLite, fake drain returning the FO1 fixture rows): first sync with a
   null cursor asks `sinceMs = now - 45 d` and writes rows; the returned cursor decodes to `{ lastOkMs }`; a second sync
   asks `startOfUtcDay(lastOkMs) - 3 d`; re-running over unchanged replies changes no row (compare `item` rows before and
   after, including `synced_at` excluded); a day inside 3 days has `finalized: false`; a drain that throws indexes
   nothing and returns/raises with the cursor unchanged; the named-set rule with `maxSeries` 2 over 4 series; recommendation
   rows; `ctx.upsertItem` is the only write path (a spy on the context); no secret appears in a thrown message.
3. Red, implement `connectors/finops-sync-transport.ts` (`withConnectorSession` + a paged drain that takes extra
   arguments; reuse `parseMcpListPage` from `connector-list-page.ts`) and `connectors/vantage-sync.ts`. Green.

### Task 10 - Static rule D4x `finops-confined`

1. Tests in `scripts/structure-audit/check-nimbus-invariants.test.ts` modeled on the D45 block (`:5781`): a fixture
   `finops/` file importing `../connectors/x.ts` as a value fails; the same as `import type` passes; `chatops/`,
   `egress/`, `federation/`, `share/`, `llm/`, `engine/`, `agents/` imports fail; a `fetch` reference, `globalThis`,
   `Bun.fetch`, `node:http` fail; a clean file passes; the real tree passes.
2. Red, implement the rule in `check-nimbus-invariants.ts` with ids `finops-forbidden-import` and `finops-no-network`
   (number D4x at merge; rename the doc headings at the same time), add the `SECURITY-INVARIANTS.md` section and move
   every "D10–D<n>" surface (`audit:status-drift` names them: CLAUDE.md/GEMINI.md, `.claude/commands/nimbus-commands.md`,
   `nimbus-file-map.md`). `bun run audit:invariants` green. Red-prove by adding a `fetch(` to `cost-series.ts`.

### Task 11 - The index-lane census

1. `bun scripts/structure-audit/check-index-lane-coverage.ts` (without `--check` it rewrites
   `docs/structure-audit/index-lane-census.json`). Expect new writer entries for `vantage:cost_allocation` and
   `vantage:cost_recommendation` and new reads for `seriesKey`, `periodEndMs`, `seriesHash` from `cost-series.ts`,
   `cost-retention.ts` and `vantage-sync.ts`. Commit the regenerated file; then `--check` passes. The census misses
   accessor-helper reads (its `knownBlindSpots`), so the reader and retention use the `json_extract` form it can see.

### Task 12 - Acceptance test (integration over real SQLite, fake MCP session, no mocks at the DB layer)

`packages/gateway/test/integration/finops/vantage.acceptance.test.ts`, one scenario per spec § 1 clause:
1. A first sync indexes 45 days grouped by the stored `group_by`; `readCostSeries` returns a gap-free daily series
   with the last 3 days `finalized: false`.
2. A second sync over unchanged replies upserts the same ids and changes no row.
3. With 6 series and `maxSeries` 3, three are named and the rest are in `__other__`; a later sync does not move a named
   series; `rowCount` is correct.
4. The retention pass with `retainDays` 30 deletes only older `cost_allocation` rows and leaves recommendations.
5. A backfill over the populated DB embeds nothing from `cost_allocation` and terminates.
6. The egress ledger gains exactly the scheduler's `sync` rows for the runs (none from the reader or retention; count
   before and after), and the token never appears in a log capture, an IPC reply or the ledger payload summaries.
7. `connector remove vantage` clears the four keys and `nimbus data delete`-equivalent clears `sync_state`, after which the
   next sync reads 45 days again.

### Task 13 - Coverage and cleanup

1. Run the new files' tests with coverage; every new file at least 85% lines and 80% branches (`audit:coverage-floor`
   is CI-Linux-authoritative; use `bun run verify:docker --changed` if available). Add tests, not exclusions. The
   type-only constants file, if it has no runtime code, is exact-path-excluded like `mapped-row.ts`; this plan avoids
   that by giving `cost-item-contract.ts` real functions.
2. `bun run typecheck:tests`: the baseline must not grow.

### Task 14 - Docs (the five core docs every PR) and CHANGELOG

- `CLAUDE.md` and `GEMINI.md` (identical edits): one "Phase 10 FO2" sentence in the status paragraph (Vantage on the
  gateway: item types, the 6 h sync, 500 series / 400 days, the cost rows never embedded, the pure reader, static D4x,
  no invariant or migration, stated bounds in short); "D10–D45" to the new ceiling; the connector counts that the
  paragraph states (it says both 94 and 95 today; re-derive from `bundled-connector-registry.ts` and fix both). Run
  `bun run audit:status-drift` and fix every surface it names.
- `docs/roadmap.md`: the *FinOps connectors* row stays `[ ]` with a dated sub-note "FO1/FO2 (Vantage) delivered; Kubecost,
  OpenCost, CloudHealth and Flexera/Spot remain" (the row completes at FO6b).
- `docs/architecture.md`: a "FinOps cost items" subsection (types, metadata keys, id scheme, the named-set rule, the
  reader, the retention pass, the embedding exclusion sites, why no migration); the D-rules mention gains D4x.
- `docs/README.md`: the Phase 10 status paragraph gains the FO2 sentence.
- `docs/cli-reference.md`: the `[finops]` table (`max_series`, `retain_days`) and `nimbus vault set vantage.*` in the
  connectors section (the five keys and which is required).
- `docs/CHANGELOG.md`: a dated entry (what the owner gets, the pin 0.14.0, the config keys, static D4x, no invariant,
  no migration, the deviations in short).
- `docs/SECURITY-INVARIANTS.md`: the D4x section (Statement, Why, Stated bounds, Enforcement); I15/I29 text unchanged.
- `docs/structure-audit/index-lane-census.json` (Task 11); `.claude/commands/nimbus-file-map.md` (one row for `finops/`,
  gated by `audit:doc-refs`) and `nimbus-commands.md` if it lists the ceiling.

### Task 15 - Final verification (run sequentially, never beside each other; a failing step hides later ones)

1. `bun run preflight:fast`.
2. `bun test packages/gateway/src`
3. `bun test packages/gateway/test packages/cli` (a `src` run does not load `test/`).
4. `bun test scripts`
5. `bun run typecheck` and `bun run typecheck:tests`.
6. `bun run audit:invariants`, `bun run audit:connector-hosts`, `bun run audit:connector-registry-drift`,
   `bun run audit:connector-version-skew`, `bun run audit:status-drift`, `bun run audit:doc-refs`.
7. `bun run preflight` if time allows; `bun run verify:docker --changed` for the Linux-only failures.
8. Known LOCAL baselines (not this branch): six migration e2e tests fail when run beside `packages/cli/src` in one
   process; five `install.ps1`/gpg tests fail on this machine; on Windows the sandbox helper must be built first. Do not
   run sandbox tests beside a background `preflight`. Anything else red is this branch.
9. Re-check `git rev-parse --abbrev-ref HEAD`, then strip `docs/superpowers/**` from the branch before the PR.

## Spec coverage (spec § 5.1, § 5.2 FO2 row, § 5.3 gateway half, § 6, § 7, mapped to a task STEP)

| Requirement | Where implemented |
| --- | --- |
| Contract module, ids, `seriesKey`, keys, `finalized` (§ 5.1, D-FO-3, D-FO-6) | Task 1; mapper keys Task 2 |
| Mapper owned by the gateway; connector rows untouched (§ 5.1) | Task 2 steps 1, 3 |
| Pure reader `readCostSeries`, no network, no writes, built from the real mapper (§ 5.1) | Task 3 steps 1-2; Task 10 |
| Vantage syncable on a `sinceMs` transport, 6 h, 45-day first window (§ 5.2, D-FO-5, § 5.3 Sync) | Task 9; deviation 2, 7 |
| Per-tool drain arguments match the connector's real zod bounds (`limit` 5000 costs, 1000 recommendations) | Task 9 step 1 |
| Re-read window of 3 days, idempotent upserts (D-FO-5, D-FO-6) | Task 9 step 2; Task 12 step 2 |
| Drain before write, a failed or 429 drain indexes nothing (§ 5.3) | Task 9 steps 1-2 |
| Personal credentials only (D-FO-7) | Task 9 step 1 |
| Max 500 series, `__other__` (D-FO-9, OR-FO-5) | Task 2 step 2; Task 4; Task 8 step 6; deviation 3 |
| Retention 400 days via the delete chokepoint (D-FO-9, OR-FO-5) | Task 5 |
| Cost rows not embedded; both named sites and the rest (D-FO-10) | Task 6; deviation 4 |
| `cost_recommendation` stays on the local embedder, never the remote one (D-FO-10, § 6) | Task 6 step 3 (not in `PROSE_HEAVY_TYPES`; pipeline test with an OpenAI-keyed stub) |
| Vault keys incl. `OPTIONAL_SECRET_KEYS` (D-FO-8, § 5.3) | Task 8 step 2; deviation 5 |
| Fixed host `api.vantage.sh`, no wildcard, `wrapServerSpec`, I1/I15/D10 (§ 5.3 Sandbox) | Task 8 steps 4-5 |
| Registration sites: catalog, meta, secrets, manifests, `phase3-config.ts` + `phase3-finops.ts`, mesh, quotas, assemble (§ 5.3) | Task 7 steps 2-3; Task 8 steps 1-6 |
| Pin `^0.14.0`, lockfile, generated registry and write manifest (§ 5.2 gate) | Task 7 steps 1, 3; deviation 6 |
| No migration, no IPC/CLI, no invariant (D-FO-11) | deviations 11, 12; Task 14 |
| Static confinement of the unattended code (§ 6, OR-10-8) | Task 10 |
| Index-lane census (§ 7) | Task 11 |
| Acceptance criterion § 1 (45 days, series, provisional, idempotent, token never leaks, reader inert) | Task 12 |
| Coverage 85/80, audits (§ 7) | Task 13; Task 15 |
| Five core docs and CHANGELOG | Task 14 |
| `[finops] max_series`, `retain_days` (D-FO-9) | Task 4 |

## Risks / open questions

- **R2, row shape for grouped costs (spec R2).** The one thing the mapper cannot get from the documented example. Task 0
  step 4 reads the OpenAPI schema; if it is silent, `tag:` groupings are refused in v1 and the first credentialed run
  is the owner's. Fixtures are documentation-shaped, not recordings, so the mapper can still be wrong against a live
  account.
- **Restatement behaviour** (spec D-FO-6): the 3-day window is our number. A vendor that restates older days leaves
  stale rows until retention; there is no upstream-deletion reconcile in any connector (spec § 8).
- **Named-set stability** (deviation 3) depends on `listIndexedMetadataValues` (a DISTINCT scan of the service's rows,
  `item-store.ts:376`) per sync: 22,500 rows worst case, once per 6 h. Measure once in Task 3 and record it.
- **FTS pollution.** `item_fts` is built over `item.body` (V48); cost rows have a title as body preview, so a keyword
  search can match them (a team name appears in 400 rows). Not changed in FO2 (a trigger change is a migration). Stated
  bound; the mitigation, if owners complain, is a migration that skips `cost_allocation` in the FTS trigger, which
  would take "V9x (next free at merge)".
- **Other readers of "recent items".** Agents and briefs that list items by recency across services could surface cost
  rows. FO2 greps `modified_at` consumers (`git grep -n "ORDER BY .*modified_at" packages/gateway/src`) in Task 6/13 and
  records any that is service-agnostic; none is expected to be affected because cost rows are a distinct service id.
- **The read tools are model-visible.** Once the Vantage server is listed in the mesh (`PHASE3_LISTING_ADDERS`), an
  owner-run agent turn can call the four read tools; results pass `wrapToolOutput` (I11). No write exists. Stated.
- **IC1 interplay.** IC1's history writer is keyed by a tracked `(service, type)` set; cost types are untracked, so no
  savepoint or history row is added for them. If IC1's `item_history` retention or `--at` reads `item` generically, cost
  rows are ordinary items.
- **Merge order with IC1/FS1.** `SECTION_LOADERS`, the D-rule ceiling surfaces and `docs/CHANGELOG.md` conflict
  mechanically; resolve by re-numbering D4x at merge.
- **Timing.** Task 7 cannot start before the npm publish. Tasks 1-6 and 10 (the pure code, config, retention, embedding
  exclusion, the rule) can proceed first; the PR cannot merge before Task 7.
- **Sync cost on the scheduler.** One spawn per 6 h; the connector paces `/costs` at 1.2 s per request, so a worst-case
  first sync of 5 cost pages takes about 6 s plus the spawn.
- **Live reply shapes** are verified against documentation only (spec § 8).

## PR

Title (conventional commit, no `!`; nothing here requires a user to act):

`feat(gateway): index Vantage cost allocation and recommendations with a daily series reader, retention, and cost rows kept out of embeddings`

Description: the data added, the 13 deviations (short), the stated bounds, the verification output, the measured
reader and named-set timings, and the dependency on `@nimbus-dev/connectors` 0.14.0. End with the attribution lines
from the session. No `Release-As:` trailer.

## Review log

### Round 1 (Antigravity, 2026-11-12)

Both major findings and all three minor ones checked and valid; applied:
- Major 1 (privacy): `PROSE_HEAVY_TYPES` routes to the remote OpenAI embedder when a key is set
  (`routing-pipeline.ts:16`), and `routing.test.ts` pins its exact membership, so Task 6 step 3 was wrong (and would have
  failed that test). Recommendations now stay on the local embedder by absence from the set; `LOCAL_ONLY_PROSE_TYPES`
  is not used because it also grants the 16 KiB body store. A pipeline test with an OpenAI-keyed stub proves no
  remote call. The spec-coverage row is updated.
- Major 2: `vantage_recommendation_list` is `cursorListInputSchema(1000)` (confirmed on the connectors `main`
  after #85 and the 0.14.0 release commit `091ab72`); the drain now sends `{ limit: 1000, cursor }`, the cost drain
  keeps `{ sinceMs, untilMs, limit: 5000, cursor }`, and Task 9 tests both against the real bounds.
- Minor: retention model recorded as deviation 12; bun.lock line numbers removed ("run `bun install`"); coverage rows
  updated.
Rejected: none. The review's quotes of `routing.ts`/`routing.test.ts` were accurate; one nuance recorded above is that
adding to `LOCAL_ONLY_PROSE_TYPES` (its suggested alternative) is unnecessary and changes a body cap.
