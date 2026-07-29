import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mapMonteCarloIncidentToItem } from "../../src/connectors/monte-carlo-dq-mapping.ts";
import { mapSnowflakeTableToItem } from "../../src/connectors/snowflake-data-model-mapping.ts";
import { mapTableauViewToItem } from "../../src/connectors/tableau-dashboard-mapping.ts";
import { upsertIndexedItem } from "../../src/index/item-store.ts";
import { LocalIndex } from "../../src/index/local-index.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const openedDbs: Database[] = [];

function makeLineageDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openedDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openedDbs.splice(0)) {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Phase 6 Slice 7 — lineage sub-chain acceptance test
// ---------------------------------------------------------------------------

test("Slice-7 lineage sub-chain resolves in <500ms with zero live API calls", () => {
  const db = makeLineageDb();

  // ── 1. Snowflake table → data_model entity external_id = 'analytics.public.revenue'
  const snowflakeItem = mapSnowflakeTableToItem(
    {
      database_name: "ANALYTICS",
      schema_name: "PUBLIC",
      table_name: "REVENUE",
      row_count: 1_000_000,
      columns: [{ name: "amount" }, { name: "currency" }],
    },
    { syncedAt: 1 },
  );
  expect(snowflakeItem).not.toBeNull();
  upsertIndexedItem(db, snowflakeItem!);

  // ── 2. Tableau view → dashboard entity; upstreamDataModelKeys references the Snowflake table
  const tableauItem = mapTableauViewToItem(
    {
      luid: "tab-view-001",
      name: "Revenue Dashboard",
      author: "analyst@example.com",
      dataSourceTables: ["ANALYTICS.PUBLIC.REVENUE"],
    },
    { syncedAt: 1 },
  );
  expect(tableauItem).not.toBeNull();
  upsertIndexedItem(db, tableauItem!);

  // ── 3. Monte Carlo incident → data_quality_test entity; monitoredTable references the Snowflake table
  const monteCarloItem = mapMonteCarloIncidentToItem(
    {
      incidentId: "42",
      monitoredTable: "ANALYTICS.PUBLIC.REVENUE",
      status: "open",
      severity: "high",
    },
    { syncedAt: 1 },
  );
  expect(monteCarloItem).not.toBeNull();
  upsertIndexedItem(db, monteCarloItem!);

  // ── measure traversal time for the lineage query
  const t0 = performance.now();

  // edges FROM the data_model node (the upstream_refs edge points FROM data_model TO dashboard)
  const fromModel = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity e ON e.id = r.from_id AND e.external_id = 'analytics.public.revenue'`,
    )
    .all()
    .map((r) => r.t);

  // edges TO the data_model node (the monitors edge points FROM data_quality_test TO data_model)
  const toModel = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity e ON e.id = r.to_id AND e.external_id = 'analytics.public.revenue'`,
    )
    .all()
    .map((r) => r.t);

  const elapsed = performance.now() - t0;

  // ── assertions
  expect(fromModel).toContain("upstream_refs"); // Snowflake table feeds the Tableau dashboard
  expect(toModel).toContain("monitors"); // Monte Carlo monitors the Snowflake table
  expect(elapsed).toBeLessThan(500);
});

test("Slice-7: mappers return null for incomplete raw inputs (no network needed)", () => {
  // Snowflake: missing table_name
  expect(
    mapSnowflakeTableToItem({ database_name: "ANALYTICS", schema_name: "PUBLIC" }, { syncedAt: 1 }),
  ).toBeNull();

  // Tableau: missing luid
  expect(mapTableauViewToItem({ name: "Revenue Dashboard" }, { syncedAt: 1 })).toBeNull();

  // Monte Carlo: missing incidentId
  expect(
    mapMonteCarloIncidentToItem(
      { monitoredTable: "db.schema.tbl", status: "open" },
      { syncedAt: 1 },
    ),
  ).toBeNull();
});

// KNOWN GAP (review F2): the FULL 6-hop chain Tableau→Looker→dbt→Snowflake→Airflow→PR is not
// asserted yet — it needs the dbt + Airflow connectors to become graph-participating first. Add
// the test then rather than carrying a permanently-skipped stub here.
