# Phase 6 Slice 7 — Wave 7a (read-only connectors + lineage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index 6 data-warehouse/BI services (Snowflake, Tableau, Looker, PowerBI, Monte Carlo, Bigeye) into the existing `data_model`/`dashboard`/`data_quality_test` item types and emit cross-connector lineage edges, so `traverseGraph` resolves the Slice-7-owned sub-chain in <500ms with zero live API calls.

**Architecture:** Each connector is a gateway-side `Syncable` (`packages/gateway/src/connectors/<name>-sync.ts` + a pure `*-mapping.ts`) that writes items via `upsertIndexedItemForSync`, which already auto-invokes `syncGraphFromIndexedItem`. Connectors stay dumb: they write **normalized data-model keys** into item `metadata`; three new graph-populator handlers read that metadata and emit the lineage edges. A V40 migration seeds the three new FK-constrained relation types. Each connector also gets a thin read-only MCP package under `packages/mcp-connectors/<name>/` for the live tool surface.

**Tech Stack:** Bun + TypeScript strict, `bun:sqlite`, Biome, the existing `connectorFetch`/`MappedRow`/`Syncable` helpers.

**Scope note:** This plan is **Wave 7a only**. Wave 7b (team-vault opt-in via the I19 local adapter) and Wave 7c (7 HITL write actions) get their own plans after 7a merges. Spec: `docs/superpowers/specs/2026-06-13-phase6-slice7-data-warehouse-bi-design.md`; review: `…-design-review.md`.

---

## File Structure

**New gateway-side files:**

- `packages/gateway/src/connectors/data-model-key.ts` — `normalizeDataModelKey()` (the cross-connector edge key)
- `packages/gateway/src/index/graph-lineage-types-v40-sql.ts` — V40 relation-type seed
- `packages/gateway/src/connectors/{snowflake,tableau,looker,powerbi,monte-carlo,bigeye}-sync.ts` — 6 sync handlers
- `packages/gateway/src/connectors/{snowflake-data-model,tableau-dashboard,looker-content,powerbi-dashboard,monte-carlo-dq,bigeye-dq}-mapping.ts` — 6 pure mappers (Looker emits two types from one file)

**Modified gateway-side files:**

- `packages/gateway/src/graph/relationship-graph.ts` — extend `ITEM_LINKED_ENTITY_TYPES`
- `packages/gateway/src/graph/graph-populator.ts` — 3 new handlers + dispatch
- `packages/gateway/src/index/migrations/runner.ts` — register V40
- `packages/gateway/src/connectors/connector-secrets-manifest.ts` — 6 secret-key entries
- `packages/gateway/src/connectors/connector-catalog.ts` — 6 service ids + sync intervals
- `packages/gateway/src/sync/rate-limiter.ts` — 6 `Provider` entries + quotas

**New MCP packages:** `packages/mcp-connectors/{snowflake,tableau,looker,powerbi,monte-carlo,bigeye}/` (server.ts + nimbus.extension.json + package.json + tsconfig + README).

**New tests:** colocated `*.test.ts` for each new gateway file + `packages/gateway/test/unit/connectors/<name>-sync.test.ts` per connector + `packages/gateway/test/integration/slice7-lineage.test.ts`.

---

## Part A — Graph + migration foundation

### Task 1: Make `data_model` / `dashboard` / `data_quality_test` graph-participating

**Files:**

- Modify: `packages/gateway/src/graph/relationship-graph.ts:6-20`
- Test: `packages/gateway/src/graph/relationship-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `relationship-graph.test.ts`:

```typescript
import { isItemLinkedGraphType } from "./relationship-graph.ts";

test("data warehouse/BI item types are graph-participating", () => {
  expect(isItemLinkedGraphType("data_model")).toBe(true);
  expect(isItemLinkedGraphType("dashboard")).toBe(true);
  expect(isItemLinkedGraphType("data_quality_test")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/relationship-graph.test.ts -t "graph-participating"`
Expected: FAIL — `expected false to be true`.

- [ ] **Step 3: Extend the constant**

In `packages/gateway/src/graph/relationship-graph.ts`, add the three entries to the end of `ITEM_LINKED_ENTITY_TYPES` (before the closing `] as const;`):

```typescript
  "obsidian_note",
  "data_model",
  "dashboard",
  "data_quality_test",
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/relationship-graph.test.ts -t "graph-participating"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/relationship-graph.ts packages/gateway/src/graph/relationship-graph.test.ts
git commit -m "feat(graph): make data_model/dashboard/data_quality_test graph-participating"
```

---

### Task 2: V40 migration — seed the lineage relation types

**Files:**

- Create: `packages/gateway/src/index/graph-lineage-types-v40-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + append a `simpleStep`)
- Test: `packages/gateway/src/index/migrations/runner-v40.test.ts`

**Why a migration is required:** `graph_relation.type` is `REFERENCES graph_relation_type(name)` (`graph-v7-sql.ts:21`) — a real FK. The populator cannot insert an `upstream_refs`/`derived_from`/`monitors` edge until that name exists in `graph_relation_type`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/migrations/runner-v40.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { LocalIndex } from "../local-index.ts";

test("V40 seeds the lineage relation types", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const names = db
    .query<{ name: string }, []>("SELECT name FROM graph_relation_type")
    .all()
    .map((r) => r.name);
  expect(names).toContain("upstream_refs");
  expect(names).toContain("derived_from");
  expect(names).toContain("monitors");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v40.test.ts`
Expected: FAIL — array does not contain `upstream_refs`.

- [ ] **Step 3: Create the V40 SQL file**

Create `packages/gateway/src/index/graph-lineage-types-v40-sql.ts`:

```typescript
// V40 — seed the data-warehouse/BI lineage relation types (Phase 6 Slice 7).
// graph_relation.type is FK-constrained to graph_relation_type(name), so these
// must exist before any lineage edge can be inserted. `upstream_refs` aligns
// with the path vocabulary agents/impact.ts already uses.
export const GRAPH_LINEAGE_TYPES_V40_SQL = `
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('upstream_refs', 1),
  ('derived_from', 1),
  ('monitors', 1);
`;
```

- [ ] **Step 4: Register the step in the runner**

In `packages/gateway/src/index/migrations/runner.ts`, add the import near the other V-SQL imports:

```typescript
import { GRAPH_LINEAGE_TYPES_V40_SQL } from "../graph-lineage-types-v40-sql.ts";
```

Then append to `INDEXED_SCHEMA_STEPS` (after the V39 `simpleStep(38, 39, …)` entry):

```typescript
  simpleStep(
    39,
    40,
    "graph lineage relation types (data-warehouse/BI lineage v40)",
    GRAPH_LINEAGE_TYPES_V40_SQL,
  ),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner-v40.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full migration runner suite (no regression)**

Run: `bun test packages/gateway/src/index/migrations/`
Expected: PASS (all existing runner-v*.test.ts still green; the schema version is now 40).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/graph-lineage-types-v40-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/runner-v40.test.ts
git commit -m "feat(index): V40 seed lineage relation types (upstream_refs/derived_from/monitors)"
```

---

### Task 3: `normalizeDataModelKey()` — the canonical cross-connector edge key

**Files:**

- Create: `packages/gateway/src/connectors/data-model-key.ts`
- Test: `packages/gateway/src/connectors/data-model-key.test.ts`

**Why:** Snowflake spells a table `DB.SCHEMA.TABLE`; Looker's `sql_table_name`, Tableau's data-source caption, and dbt's `database.schema.alias` spell the same table differently (case, quotes, optional db prefix). Edges only converge on the graph node if both ends normalize to one key.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/data-model-key.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { normalizeDataModelKey } from "./data-model-key.ts";

test("lowercases, unquotes, and keeps db.schema.table", () => {
  expect(normalizeDataModelKey('ANALYTICS.PUBLIC."Revenue"')).toBe("analytics.public.revenue");
  expect(normalizeDataModelKey("`analytics`.`public`.`revenue`")).toBe("analytics.public.revenue");
});

test("two-part schema.table is preserved (no synthetic db prefix)", () => {
  expect(normalizeDataModelKey("public.revenue")).toBe("public.revenue");
});

test("trims surrounding whitespace and collapses brackets", () => {
  expect(normalizeDataModelKey("  [Analytics].[Public].[Revenue]  ")).toBe("analytics.public.revenue");
});

test("returns null for empty / unusable input", () => {
  expect(normalizeDataModelKey("")).toBeNull();
  expect(normalizeDataModelKey("   ")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/data-model-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/connectors/data-model-key.ts`:

```typescript
/**
 * Canonical key for a warehouse table/view, shared across every Slice-7
 * connector so cross-connector lineage edges converge on ONE graph node.
 * Lower-cases, strips quoting (`"` / `` ` `` / `[]`), trims each part, and
 * joins with `.`. Returns null when no usable identifier survives.
 *
 * LIMITATION (deliberate, YAGNI): splits blindly on `.`, so a *quoted literal
 * dot* inside an identifier (e.g. `ANALYTICS.PUBLIC."Sales.2026"`) is split
 * into extra parts. Warehouse identifiers containing literal dots are
 * vanishingly rare; a quote-aware tokenizer is intentionally not implemented.
 */
export function normalizeDataModelKey(raw: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parts = raw
    .split(".")
    .map((p) =>
      p
        .trim()
        .replace(/^[`"\[]+/, "")
        .replace(/[`"\]]+$/, "")
        .trim()
        .toLowerCase(),
    )
    .filter((p) => p !== "");
  return parts.length === 0 ? null : parts.join(".");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/data-model-key.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/data-model-key.ts packages/gateway/src/connectors/data-model-key.test.ts
git commit -m "feat(connectors): normalizeDataModelKey for cross-connector lineage"
```

---

### Task 4: `syncDataModelGraph` populator handler (+ `derived_from` edges)

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts` (add handler + dispatch branch)
- Test: `packages/gateway/src/graph/graph-populator.test.ts`

**Contract:** a `data_model` item's `metadata` may carry `dataModelKey: string` (this node's normalized key) and `derivedFromKeys: string[]` (upstream model keys). The handler upserts a `data_model` entity keyed by `dataModelKey` (falling back to the item id) and, for each `derivedFromKey`, upserts the target `data_model` entity and emits `data_model --derived_from--> data_model`.

- [ ] **Step 1: Write the failing test**

Add to `graph-populator.test.ts` (follow the existing test harness in that file — an in-memory db with `LocalIndex.ensureSchema`):

```typescript
test("data_model item emits a derived_from edge to its upstream key", () => {
  const db = makeGraphDb(); // existing helper in this test file
  syncGraphFromIndexedItem(db, {
    id: "looker:model/revenue",
    service: "looker",
    type: "data_model",
    title: "revenue",
    authorId: null,
    metadata: { dataModelKey: "analytics.public.revenue", derivedFromKeys: ["dbt.marts.revenue"] },
  });
  const edge = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity f ON f.id = r.from_id AND f.external_id = 'analytics.public.revenue'
       JOIN graph_entity g ON g.id = r.to_id   AND g.external_id = 'dbt.marts.revenue'`,
    )
    .get();
  expect(edge?.t).toBe("derived_from");
});
```

(If `graph-populator.test.ts` has no `makeGraphDb` helper, add one: `new Database(":memory:")` + `LocalIndex.ensureSchema(db)`, mirroring `runner-v40.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator.test.ts -t "derived_from"`
Expected: FAIL — no rows (no handler yet).

- [ ] **Step 3: Add the handler + a shared metadata helper + dispatch**

In `graph-populator.ts`, add a string-array metadata reader near `stringField`:

```typescript
function stringArrayField(meta: Record<string, unknown>, key: string): string[] {
  const v = meta[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}
```

Add the handler:

```typescript
function syncDataModelGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const key = stringField(row.metadata, "dataModelKey") ?? row.id;
  const modelId = upsertGraphEntity(db, {
    type: "data_model",
    externalId: key,
    label: row.title,
    service: row.service,
  });
  clearRelationsTouchingEntity(db, modelId);
  for (const upstream of stringArrayField(row.metadata, "derivedFromKeys")) {
    const upId = upsertGraphEntity(db, {
      type: "data_model",
      externalId: upstream,
      label: upstream,
      service: row.service,
    });
    upsertGraphRelation(db, modelId, upId, "derived_from", now);
  }
}
```

Register it in `syncGraphFromIndexedItem` (add before the final closing brace, mirroring the existing `if (row.type === …)` branches):

```typescript
  if (row.type === "data_model") {
    syncDataModelGraph(db, row, now);
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/graph-populator.test.ts -t "derived_from"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator.test.ts
git commit -m "feat(graph): syncDataModelGraph emits derived_from lineage edges"
```

---

### Task 5: `syncDashboardGraph` populator handler (+ `upstream_refs` edges)

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts`
- Test: `packages/gateway/src/graph/graph-populator.test.ts`

**Contract:** a `dashboard` item's `metadata` may carry `upstreamDataModelKeys: string[]`. The handler upserts the `dashboard` entity and, for each upstream key, upserts a `data_model` entity and emits `data_model --upstream_refs--> dashboard` (table feeds the BI view).

- [ ] **Step 1: Write the failing test**

```typescript
test("dashboard item emits upstream_refs from each upstream data_model", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "tableau:view/q1-revenue",
    service: "tableau",
    type: "dashboard",
    title: "Q1 Revenue",
    authorId: null,
    metadata: { upstreamDataModelKeys: ["analytics.public.revenue"] },
  });
  const edge = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity f ON f.id = r.from_id AND f.external_id = 'analytics.public.revenue'
       JOIN graph_entity g ON g.id = r.to_id   AND g.type = 'dashboard'`,
    )
    .get();
  expect(edge?.t).toBe("upstream_refs");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator.test.ts -t "upstream_refs"`
Expected: FAIL.

- [ ] **Step 3: Add the handler + dispatch**

```typescript
function syncDashboardGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const dashId = upsertGraphEntity(db, {
    type: "dashboard",
    externalId: row.id,
    label: row.title,
    service: row.service,
  });
  clearRelationsTouchingEntity(db, dashId);
  for (const upstream of stringArrayField(row.metadata, "upstreamDataModelKeys")) {
    const modelId = upsertGraphEntity(db, {
      type: "data_model",
      externalId: upstream,
      label: upstream,
      service: row.service,
    });
    upsertGraphRelation(db, modelId, dashId, "upstream_refs", now);
  }
}
```

Dispatch:

```typescript
  if (row.type === "dashboard") {
    syncDashboardGraph(db, row, now);
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/graph-populator.test.ts -t "upstream_refs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator.test.ts
git commit -m "feat(graph): syncDashboardGraph emits upstream_refs lineage edges"
```

---

### Task 6: `syncDataQualityTestGraph` populator handler (+ `monitors` edges)

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts`
- Test: `packages/gateway/src/graph/graph-populator.test.ts`

**Contract:** a `data_quality_test` item's `metadata` may carry `monitoredDataModelKeys: string[]`. The handler upserts the `data_quality_test` entity and emits `data_quality_test --monitors--> data_model` per key.

- [ ] **Step 1: Write the failing test**

```typescript
test("data_quality_test item emits a monitors edge to its table", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "montecarlo:incident/42",
    service: "montecarlo",
    type: "data_quality_test",
    title: "freshness breach on revenue",
    authorId: null,
    metadata: { monitoredDataModelKeys: ["analytics.public.revenue"] },
  });
  const edge = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity f ON f.id = r.from_id AND f.type = 'data_quality_test'
       JOIN graph_entity g ON g.id = r.to_id   AND g.external_id = 'analytics.public.revenue'`,
    )
    .get();
  expect(edge?.t).toBe("monitors");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator.test.ts -t "monitors edge"`
Expected: FAIL.

- [ ] **Step 3: Add the handler + dispatch**

```typescript
function syncDataQualityTestGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const dqId = upsertGraphEntity(db, {
    type: "data_quality_test",
    externalId: row.id,
    label: row.title,
    service: row.service,
  });
  clearRelationsTouchingEntity(db, dqId);
  for (const table of stringArrayField(row.metadata, "monitoredDataModelKeys")) {
    const modelId = upsertGraphEntity(db, {
      type: "data_model",
      externalId: table,
      label: table,
      service: row.service,
    });
    upsertGraphRelation(db, dqId, modelId, "monitors", now);
  }
}
```

Dispatch (this is the last branch; the existing function ends with the `obsidian_note` branch — add after it):

```typescript
  if (row.type === "data_quality_test") {
    syncDataQualityTestGraph(db, row, now);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/graph-populator.test.ts -t "monitors edge"`
Expected: PASS.

- [ ] **Step 5: Run the whole graph suite (no regression)**

Run: `bun test packages/gateway/src/graph/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator.test.ts
git commit -m "feat(graph): syncDataQualityTestGraph emits monitors lineage edges"
```

---

## Part B — Snowflake connector (full exemplar)

> Connectors 2–6 (Part C) follow this exact structure: a pure `*-mapping.ts` (TDD), a `*-sync.ts` `Syncable` (TDD against a fake fetch), the three-file registration, then the MCP package. Read Tasks 7–10 before starting any Part-C connector.

### Task 7: Snowflake `data_model` mapper

**Files:**

- Create: `packages/gateway/src/connectors/snowflake-data-model-mapping.ts`
- Test: `packages/gateway/src/connectors/snowflake-data-model-mapping.test.ts`

**Indexed shape:** one `data_model` item per table/view. Metadata carries `dataModelKey` (normalized `db.schema.table`), `columns` (name + tag only — **no values**), `rowCountEstimate`, `lastAltered`. No `derivedFromKeys` (Snowflake is a source, not derived).

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { mapSnowflakeTableToItem } from "./snowflake-data-model-mapping.ts";

test("maps a table to a data_model item with a normalized key and no cell values", () => {
  const item = mapSnowflakeTableToItem(
    {
      database_name: "ANALYTICS",
      schema_name: "PUBLIC",
      table_name: "REVENUE",
      row_count: 1234,
      last_altered: "2026-06-01T00:00:00Z",
      columns: [{ name: "AMOUNT", tag: "pii:false" }],
    },
    { syncedAt: 1_000 },
  );
  expect(item?.type).toBe("data_model");
  expect(item?.externalId).toBe("snowflake:analytics.public.revenue");
  expect(item?.metadata.dataModelKey).toBe("analytics.public.revenue");
  expect(JSON.stringify(item?.metadata)).not.toContain("1234abc"); // sanity: no row data
  expect(item?.metadata.rowCountEstimate).toBe(1234);
});

test("returns null when the table name is missing", () => {
  expect(mapSnowflakeTableToItem({ database_name: "A", schema_name: "B" }, { syncedAt: 1 })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/snowflake-data-model-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the mapper**

```typescript
import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export type SnowflakeMappedRow = MappedRow<"snowflake", "data_model">;
export interface SnowflakeMappingContext { readonly syncedAt: number; }

const SERVICE = "snowflake" as const;
const TYPE = "data_model" as const;

export function mapSnowflakeTableToItem(
  raw: unknown,
  ctx: SnowflakeMappingContext,
): SnowflakeMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;
  const db = stringField(r, "database_name");
  const schema = stringField(r, "schema_name");
  const table = stringField(r, "table_name");
  if (db === undefined || schema === undefined || table === undefined) return null;
  const key = normalizeDataModelKey(`${db}.${schema}.${table}`);
  if (key === null) return null;

  const rawCols = Array.isArray(r["columns"]) ? r["columns"] : [];
  const columns = rawCols
    .map((c) => asRecord(c))
    .filter((c): c is Record<string, unknown> => c !== undefined)
    .map((c) => ({ name: stringField(c, "name") ?? "", tag: stringField(c, "tag") ?? null }))
    .filter((c) => c.name !== "");
  const rowCountEstimate = numberField(r, "row_count") ?? null;
  const lastAltered = stringField(r, "last_altered") ?? null;

  return {
    service: SERVICE,
    type: TYPE,
    externalId: `snowflake:${key}`,
    title: `${schema}.${table}`,
    bodyPreview: `${columns.length} columns · ${rowCountEstimate === null ? "rows unknown" : `~${rowCountEstimate} rows`}`,
    url: null,
    canonicalUrl: null,
    modifiedAt: lastAltered !== null ? Date.parse(lastAltered) || ctx.syncedAt : ctx.syncedAt,
    metadata: { dataModelKey: key, columns, rowCountEstimate, lastAltered },
    syncedAt: ctx.syncedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/snowflake-data-model-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/snowflake-data-model-mapping.ts packages/gateway/src/connectors/snowflake-data-model-mapping.test.ts
git commit -m "feat(snowflake): data_model mapper (schema-only, normalized key)"
```

---

### Task 8: Snowflake sync handler

**Files:**

- Create: `packages/gateway/src/connectors/snowflake-sync.ts`
- Test: `packages/gateway/test/unit/connectors/snowflake-sync.test.ts`

**Pattern:** mirror `metabase-sync.ts` exactly — `createSnowflakeSyncable(options)` returning a `Syncable`; `loadCreds` from `readConnectorSecret(ctx.vault, "snowflake", …)`; fetch via `connectorFetch(ctx, "snowflake", url, …)`; map each row with `mapSnowflakeTableToItem`; `upsertIndexedItemForSync(ctx, mapped)`; return `syncPassCursorSuccess`/`…HttpEmpty`/`…ParseEmpty`/`syncNoopResult`. Creds: `account`, plus `oauth_token` OR `key_pair_jwt` OR `password` (auth-mode resolved in `loadCreds`; for Wave 7a a single bearer/JWT header is enough — Key-Pair JWT minting is a Part-C/plan refinement, see spec F6).

- [ ] **Step 1: Write the failing test**

This uses the REAL test helpers (verified): `createMemoryIndexDb`, `createStubVault`,
`syncTestContext`, `describeWithFetchRestore` (saves/restores `globalThis.fetch`), and
`expectServiceItemCount`. Network connectors fake by replacing `globalThis.fetch` — there is no
fetch-enqueue fixture. The vault is a read-only stub keyed by full `"<service>.<key>"` keys.

```typescript
import { expect, test } from "bun:test";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createSnowflakeSyncable } from "../../../src/connectors/snowflake-sync.ts";

// Snowflake's statements API returns column metadata + row-arrays, not named objects.
function statementsResponse(rows: string[][]): Response {
  return new Response(
    JSON.stringify({
      resultSetMetaData: {
        rowType: [
          { name: "DATABASE_NAME" },
          { name: "SCHEMA_NAME" },
          { name: "TABLE_NAME" },
          { name: "ROW_COUNT" },
          { name: "LAST_ALTERED" },
        ],
      },
      data: rows,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describeWithFetchRestore("snowflake-sync", () => {
  test("indexes Snowflake tables as data_model items", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "snowflake.account": "acme-xy12345", "snowflake.oauth_token": "tok" });
    globalThis.fetch = (async () =>
      statementsResponse([["ANALYTICS", "PUBLIC", "REVENUE", "10", "2026-06-01T00:00:00Z"]])) as typeof fetch;

    const syncable = createSnowflakeSyncable({ ensureSnowflakeMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);

    expect(res.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "snowflake", 1);
    const row = db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'snowflake'")
      .get();
    expect(row?.external_id).toBe("snowflake:analytics.public.revenue");
  });

  test("no creds → noop (zero upserts)", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({}); // no snowflake.* keys
    const syncable = createSnowflakeSyncable({ ensureSnowflakeMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expect(res.itemsUpserted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/test/unit/connectors/snowflake-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the sync handler** (mirror `metabase-sync.ts`)

```typescript
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSnowflakeTableToItem } from "./snowflake-data-model-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "snowflake";
const CURSOR_PREFIX = "nimbus-snowflake1:";
function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 });
}

export type SnowflakeSyncableOptions = { ensureSnowflakeMcpRunning: () => Promise<void> };
interface SnowflakeCreds { readonly account: string; readonly token: string; }

async function loadCreds(ctx: SyncContext): Promise<SnowflakeCreds | null> {
  const account = (await readConnectorSecret(ctx.vault, "snowflake", "account"))?.trim() ?? "";
  const token =
    (await readConnectorSecret(ctx.vault, "snowflake", "oauth_token"))?.trim() ??
    (await readConnectorSecret(ctx.vault, "snowflake", "key_pair_jwt"))?.trim() ??
    "";
  if (account === "" || token === "") return null;
  return { account, token };
}

// Snowflake's SQL REST API (POST /api/v2/statements) returns column metadata in
// `resultSetMetaData.rowType` and rows as positional arrays in `data`. Zip them
// into the lower-cased named objects the mapper consumes. (No native
// /information-schema endpoint exists — review finding Q2.2.)
function rowsFromStatementsResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  const meta = asRecord(root?.["resultSetMetaData"]);
  const rowType = Array.isArray(meta?.["rowType"]) ? meta["rowType"] : [];
  const names = rowType.map((c) => (asRecord(c)?.["name"] as string | undefined)?.toLowerCase() ?? "");
  const data = Array.isArray(root?.["data"]) ? root["data"] : [];
  const out: Record<string, unknown>[] = [];
  for (const r of data) {
    if (!Array.isArray(r)) continue;
    const obj: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (name !== "") obj[name] = r[i];
    });
    // row_count arrives as a string; coerce so the mapper's numberField reads it.
    if (typeof obj["row_count"] === "string") obj["row_count"] = Number(obj["row_count"]);
    out.push(obj);
  }
  return out;
}

const TABLES_SQL =
  "SELECT table_catalog AS database_name, table_schema AS schema_name, table_name, " +
  "row_count, last_altered FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA'";

export function createSnowflakeSyncable(options: SnowflakeSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSnowflakeMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      const url = `https://${creds.account}.snowflakecomputing.com/api/v2/statements`;
      const outcome = await connectorFetch(ctx, SERVICE_ID, url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ statement: TABLES_SQL, timeout: 60 }),
      });
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }
      const now = Date.now();
      let upserted = 0;
      for (const rawRow of rowsFromStatementsResponse(outcome.parsed)) {
        const mapped = mapSnowflakeTableToItem(rawRow, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }
      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/test/unit/connectors/snowflake-sync.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/snowflake-sync.ts packages/gateway/test/unit/connectors/snowflake-sync.test.ts
git commit -m "feat(snowflake): gateway sync handler (data_model indexing)"
```

---

### Task 9: Register Snowflake (secrets manifest + catalog + rate-limiter)

**Files:**

- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts`
- Modify: `packages/gateway/src/connectors/connector-catalog.ts`
- Modify: `packages/gateway/src/sync/rate-limiter.ts`
- Test: typecheck + the existing manifest/catalog drift tests

**Why all three together:** the `CONNECTOR_VAULT_SECRET_KEYS`, `CONNECTOR_SERVICE_IDS`, and `Provider` types are `satisfies`/keyed-by each other; adding a service id without the sibling entries is a `tsc` error (see the connector-plan-wiring coupling note). `bun test` alone can hide it — run `tsc`.

- [ ] **Step 1: Add the secrets-manifest entry**

In `connector-secrets-manifest.ts`, inside `CONNECTOR_VAULT_SECRET_KEYS`:

```typescript
  snowflake: ["snowflake.account", "snowflake.oauth_token", "snowflake.key_pair_jwt"],
```

> **Typing constraint (do not "simplify" to bare keys):** `ConnectorSecretKeyOf<S>` statically
> requires every entry to be `` `${serviceId}.${suffix}` `` (`connector-vault.ts:97`), and
> `readConnectorSecret(ctx.vault, "snowflake", "account")` reads `vault.get("snowflake.account")`.
> The `service.` prefix is mandatory — a bare `"account"` is a `tsc` error.

- [ ] **Step 2: Add the catalog entries**

In `connector-catalog.ts`: add `"snowflake",` to `CONNECTOR_SERVICE_IDS`, and `snowflake: MIN10,` to `CONNECTOR_SYNC_INTERVAL_MS`.

- [ ] **Step 3: Add the rate-limiter entries**

In `rate-limiter.ts`: add `| "snowflake"` to the `Provider` union and `snowflake: { requestsPerMinute: 60, burstSize: 10 },` to `DEFAULT_QUOTAS`.

- [ ] **Step 4: Typecheck + drift tests**

Run: `bunx tsc -p packages/gateway --noEmit`
Expected: no errors.
Run: `bun test packages/gateway/src/connectors/connector-secrets-manifest.test.ts packages/gateway/src/connectors/connector-catalog.test.ts`
Expected: PASS (if these drift tests assert counts, update the expected count by +1).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/connector-secrets-manifest.ts packages/gateway/src/connectors/connector-catalog.ts packages/gateway/src/sync/rate-limiter.ts
git commit -m "feat(snowflake): register secrets/catalog/rate-limiter"
```

---

### Task 10: Snowflake MCP package + config + sync-registry wiring

**Files:**

- Create: `packages/mcp-connectors/snowflake/{package.json,tsconfig.json,nimbus.extension.json,README.md,src/server.ts}`
- Modify: wherever syncables are assembled into the scheduler (grep for `createMetabaseSyncable(` to find the registration site, e.g. `connectors/registry.ts` or `platform/assemble.ts`)
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (add a `[connectors.snowflake]` parser section, mirroring an existing connector section)

- [ ] **Step 1: Scaffold the MCP package**

Run: `cd packages/mcp-connectors && bun ../../node_modules/.bin/nimbus scaffold extension --name snowflake --output ./snowflake` (or copy `metabase/` and rename). Then set `nimbus.extension.json`:

```json
{
  "id": "com.nimbus.snowflake",
  "displayName": "Snowflake",
  "version": "0.1.0",
  "description": "Indexes Snowflake databases/schemas/tables (column names + tags only, NEVER row data), tasks, and pipe status as data_model items.",
  "author": "Nimbus",
  "entrypoint": "dist/server.js",
  "runtime": "bun",
  "permissions": { "network": [], "filesystem": { "read": [], "write": [] } },
  "hitlRequired": [],
  "syncInterval": 600,
  "minNimbusVersion": "0.5.0"
}
```

(`network: []` — the account host is per-tenant and merged at runtime, matching the dbt/metabase dynamic-host pattern.)

- [ ] **Step 2: Write `src/server.ts`** (mirror `mcp-connectors/metabase/src/server.ts`)

```typescript
import { z } from "zod";
import { jsonResult, runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

await runReadOnlyMcpConnector("nimbus-snowflake", (reg) => {
  reg("snowflake_list", "List indexed Snowflake tables/views (data_model).",
    z.object({ limit: z.number().int().min(1).max(500).optional() }),
    async () => jsonResult({ items: [] }));
  reg("snowflake_get", "Get one Snowflake table/view by key.",
    z.object({ key: z.string() }), async () => jsonResult({ item: null }));
  reg("snowflake_search", "Search Snowflake tables/views.",
    z.object({ query: z.string() }), async () => jsonResult({ items: [] }));
});
```

- [ ] **Step 3: Register the syncable in the scheduler**

At the site that lists syncables (the same place `createMetabaseSyncable(...)` is registered), add `createSnowflakeSyncable({ ensureSnowflakeMcpRunning })` following the existing `ensure<Name>McpRunning` lazy-spawn pattern used by the sibling connectors.

- [ ] **Step 4: Add the nimbus.toml config section**

In `config/nimbus-toml.ts`, add a `[connectors.snowflake]` parser mirroring an existing connector section (keys: `account`, `auth_mode`, and the Wave-7b `credential = "personal"|"team"` placeholder — default `"personal"`).

- [ ] **Step 5: Contract test + typecheck**

Run: `cd packages/mcp-connectors/snowflake && bun install && bun run ../../node_modules/.bin/nimbus test`
Expected: contract tests PASS (list/get/search present, manifest valid).
Run: `bunx tsc -p packages/gateway --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/snowflake packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/connectors/registry.ts
git commit -m "feat(snowflake): MCP package + config + scheduler registration"
```

---

## Part C — Connectors 2–6

Each connector repeats Tasks 7–10 (mapper → sync → registration → MCP package + config + scheduler) with the per-connector specifics below. Use the same TDD step rhythm (failing test → fail → implement → pass → commit) and the same files-per-task layout. Only the **deltas** differ.

### Task 11: Tableau (`dashboard`)

- **Mapper** `tableau-dashboard-mapping.ts` → `MappedRow<"tableau","dashboard">`. Item per view/workbook. `externalId: "tableau:<luid>"`. Metadata: `{ upstreamDataModelKeys, author, folder, extractRefreshStatus }`, where `upstreamDataModelKeys` = each upstream table from the view's data-source connection metadata, run through `normalizeDataModelKey`. **This is the Tableau→Snowflake edge source.**
- **Sync** `tableau-sync.ts`: creds `tableau.url` + `tableau.pat_name` + `tableau.pat_secret`; sign-in to `POST /api/3.x/auth/signin` for a token, then `GET /api/3.x/sites/{id}/views` (+ the Metadata API GraphQL for data-source→table lineage). Mirror Task 8.
- **Register**: secret keys `["tableau.url","tableau.pat_name","tableau.pat_secret"]`; catalog `tableau: MIN10`; rate-limiter `tableau`.
- **MCP**: `com.nimbus.tableau`, tools `tableau_list/get/search`.
- **Test assertion**: a seeded view with a Snowflake data-source yields a `dashboard` item whose `metadata.upstreamDataModelKeys` contains `analytics.public.revenue`.

### Task 12: Looker (`dashboard` + `data_model`)

- **Mapper** `looker-content-mapping.ts` exporting `mapLookerDashboardToItem` (→ `dashboard`) and `mapLookerViewToItem` (→ `data_model`). For a LookML view, `metadata.dataModelKey = normalizeDataModelKey(view.sql_table_name)` and `metadata.derivedFromKeys = [normalizeDataModelKey(sql_table_name)]` pointing at the dbt model. **This is the Looker→dbt edge source.**
- **Sync** `looker-sync.ts`: creds `looker.base_url` + `looker.client_id` + `looker.client_secret`; `POST /api/4.0/login` → token; `GET /api/4.0/dashboards` + `/lookml_models`. Two item types from one sync (upsert both).
- **Register**: secret keys `["looker.base_url","looker.client_id","looker.client_secret"]`; catalog `looker: MIN10`; rate-limiter `looker`.
- **MCP**: `com.nimbus.looker`, tools `looker_list/get/search`.
- **Test assertion**: a LookML view with `sql_table_name: "analytics.public.revenue"` yields a `data_model` item whose `metadata.derivedFromKeys` contains `analytics.public.revenue`.

### Task 13: PowerBI (`dashboard`)

- **Mapper** `powerbi-dashboard-mapping.ts` → `MappedRow<"powerbi","dashboard">`. Item per report/dashboard. Metadata: `{ upstreamDataModelKeys (from dataset table schema), workspace, datasetId }` (schema only — no rows).
- **Sync** `powerbi-sync.ts`: creds `powerbi.tenant_id` + `powerbi.client_id` + `powerbi.client_secret`; AAD client-credentials token from `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` (scope `https://analysis.windows.net/powerbi/api/.default`), then `GET https://api.powerbi.com/v1.0/myorg/groups` + `/reports` + `/datasets/{id}/tables`.
- **Register**: secret keys `["powerbi.tenant_id","powerbi.client_id","powerbi.client_secret"]`; catalog `powerbi: MIN10`; rate-limiter `powerbi`.
- **MCP**: `com.nimbus.powerbi`, tools `powerbi_list/get/search`.
- **Test assertion**: a report over a dataset with table `revenue` yields a `dashboard` item with the normalized key in `upstreamDataModelKeys`.

### Task 14: Monte Carlo (`data_quality_test`)

> **Canonical service id is `montecarlo`** (no hyphen) at every TYPED site — the mapper `service`
> literal, the `CONNECTOR_VAULT_SECRET_KEYS` prefix (`montecarlo.api_id`), `CONNECTOR_SERVICE_IDS`,
> the rate-limiter `Provider`, and the `connectorFetch(ctx, "montecarlo", …)` arg. Only the package
> directory (`monte-carlo/`) and manifest id (`com.nimbus.monte-carlo`) may use the hyphen. A split
> breaks the `ConnectorSecretKeyOf` template-literal match (review finding R4).

- **Mapper** `monte-carlo-dq-mapping.ts` → `MappedRow<"montecarlo","data_quality_test">`. Item per incident/monitor. `externalId: "montecarlo:<incidentId>"`. Metadata: `{ monitoredDataModelKeys (from the monitored table → normalizeDataModelKey), status, severity, firstSeenAt }`.
- **Sync** `monte-carlo-sync.ts`: creds `montecarlo.api_id` + `montecarlo.api_token`; GraphQL `POST https://api.getmontecarlo.com/graphql` (headers `x-mcd-id`, `x-mcd-token`).
- **Register**: secret keys `["montecarlo.api_id","montecarlo.api_token"]`; catalog `montecarlo: MIN10`; rate-limiter `montecarlo`.
- **MCP**: `com.nimbus.monte-carlo`, tools `montecarlo_list/get/search`.
- **Test assertion**: a seeded incident on table `analytics.public.revenue` yields a `data_quality_test` item whose `metadata.monitoredDataModelKeys` contains the normalized key.

### Task 15: Bigeye (`data_quality_test`)

- **Mapper** `bigeye-dq-mapping.ts` → `MappedRow<"bigeye","data_quality_test">`. Item per metric/SLA breach. Metadata: `{ monitoredDataModelKeys, slaStatus, anomaly }`.
- **Sync** `bigeye-sync.ts`: creds `bigeye.base_url` + `bigeye.api_key`; `GET {base_url}/api/v1/issues` (+ monitored-table endpoint). Bearer auth.
- **Register**: secret keys `["bigeye.base_url","bigeye.api_key"]`; catalog `bigeye: MIN10`; rate-limiter `bigeye`.
- **MCP**: `com.nimbus.bigeye`, tools `bigeye_list/get/search`.
- **Test assertion**: a seeded SLA breach on a monitored table yields a `data_quality_test` item with the normalized key in `monitoredDataModelKeys`.

> After each of Tasks 11–15: `bunx tsc -p packages/gateway --noEmit` and `bun test packages/gateway/test/unit/connectors/<name>-sync.test.ts` green, then commit `feat(<name>): read-only connector + lineage metadata`.

---

## Part D — Lineage acceptance + verification

### Task 16: Slice-7 sub-chain lineage integration test (<500ms, zero live API)

**Files:**

- Create: `packages/gateway/test/integration/slice7-lineage.test.ts`

**Asserts** the four owned hops compose via the existing `traverseGraph` over a real SQLite db seeded purely by running the mappers (no network):

- [ ] **Step 1: Write the test**

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { LocalIndex } from "../../src/index/local-index.ts";
import { upsertIndexedItem } from "../../src/index/item-store.ts";
// Seed via the pure mappers so no network is involved.
import { mapSnowflakeTableToItem } from "../../src/connectors/snowflake-data-model-mapping.ts";
import { mapTableauViewToItem } from "../../src/connectors/tableau-dashboard-mapping.ts";
import { mapMonteCarloIncidentToItem } from "../../src/connectors/monte-carlo-dq-mapping.ts";

test("Slice-7 lineage sub-chain resolves in <500ms with zero live API calls", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  // upsertIndexedItem takes the MappedRow shape directly AND already calls
  // syncGraphFromIndexedItem internally, so seeding items auto-populates the graph.
  // 1. Snowflake table → data_model node 'analytics.public.revenue'
  upsertIndexedItem(db, mapSnowflakeTableToItem(
    { database_name: "ANALYTICS", schema_name: "PUBLIC", table_name: "REVENUE", row_count: 1, columns: [{ name: "amount" }] },
    { syncedAt: 1 })!);
  // 2. Tableau view referencing that table → dashboard, edge data_model --upstream_refs--> dashboard
  upsertIndexedItem(db, mapTableauViewToItem(
    { luid: "v1", name: "Q1 Revenue", dataSourceTables: ["ANALYTICS.PUBLIC.REVENUE"] },
    { syncedAt: 1 })!);
  // 3. Monte Carlo incident on that table → data_quality_test, edge ... --monitors--> data_model
  upsertIndexedItem(db, mapMonteCarloIncidentToItem(
    { incidentId: "42", monitoredTable: "ANALYTICS.PUBLIC.REVENUE", status: "open", severity: "high" },
    { syncedAt: 1 })!);

  const t0 = performance.now();
  const edges = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity e ON e.id = r.from_id AND e.external_id = 'analytics.public.revenue'`,
    )
    .all()
    .map((r) => r.t);
  const elapsed = performance.now() - t0;

  expect(edges).toContain("upstream_refs"); // table feeds the Tableau dashboard
  expect(elapsed).toBeLessThan(500);
});
```

> `mapTableauViewToItem` / `mapMonteCarloIncidentToItem` are defined in Tasks 11 & 14 — keep their example input shapes here in sync with what those tasks implement.

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/integration/slice7-lineage.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/slice7-lineage.test.ts
git commit -m "test(slice7): lineage sub-chain resolves <500ms with zero live API"
```

### Task 17: Full-chain stretch test (skipped) + preflight

**Files:**

- Modify: `packages/gateway/test/integration/slice7-lineage.test.ts`

- [ ] **Step 1: Add a `test.skip` documenting the stretch**

```typescript
test.skip("FULL 6-hop chain Tableau→Looker→dbt→Snowflake→Airflow→PR (needs dbt+Airflow graph participation — review F2)", () => {
  // Unskip once the dbt + Airflow connectors become graph-participating.
});
```

- [ ] **Step 2: Run the connector + graph suites**

Run: `bun test packages/gateway/src/connectors/ packages/gateway/src/graph/ packages/gateway/test/unit/connectors/`
Expected: PASS.

- [ ] **Step 3: Coverage floor (CI-Linux-authoritative) + full preflight**

Run: `bun run audit:coverage-floor` (verify the new gateway files clear ≥80% line+branch; Docker/Linux if local differs — see the coverage-floor notes).
Run: `bun run preflight`
Expected: all gates green; the security-invariants test count is **unchanged** (no new invariant).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/integration/slice7-lineage.test.ts
git commit -m "test(slice7): document full-chain stretch (skipped, depends on dbt+Airflow graph)"
```

---

## Self-Review (run after implementation, before PR)

- **Spec coverage:** 6 connectors (Tasks 7–15) ✓; existing item types reused ✓; 3 populator handlers (Tasks 4–6) ✓; V40 (Task 2) ✓; `normalizeDataModelKey` (Task 3) ✓; sub-chain acceptance (Task 16) ✓; full chain marked stretch (Task 17) ✓; no new invariant (Task 17 step 3) ✓. **Out of scope by design:** team-vault opt-in (Wave 7b), 7 write actions (Wave 7c) — separate plans.
- **Per-connector READMEs:** add the public-tier H2 sections before PR (`bun run audit:package-readmes` — not in `test:ci`).
- **CHANGELOG:** one entry per connector in `docs/CHANGELOG.md` (do NOT touch the CLAUDE.md/GEMINI.md status line).
- **Drift counts:** if `connector-catalog`/`secrets-manifest`/Tauri-connector-count tests assert totals, bump expected counts by 6.
