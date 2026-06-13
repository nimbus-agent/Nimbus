/**
 * Tests for the data-warehouse/BI lineage handlers in graph-populator.ts:
 *   syncDataModelGraph   — derived_from edges
 *   syncDashboardGraph   — upstream_refs edges
 *   syncDataQualityTestGraph — monitors edges
 *
 * The V40 migration (which seeds these relation types into graph_relation_type)
 * is not yet landed.  We seed them here so the graph_relation FK is satisfied
 * and each test is self-contained.
 */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const openedDbs: Database[] = [];

function makeGraphDb(): Database {
  const db = createMemoryIndexDb();
  // Seed relation types that will be added by V40; keeps tests self-contained.
  db.run(
    `INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
       ('derived_from', 1),
       ('upstream_refs', 1),
       ('monitors', 1)`,
  );
  openedDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openedDbs.splice(0)) {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Task 4 — syncDataModelGraph
// ---------------------------------------------------------------------------

test("data_model item emits a derived_from edge to its upstream key", () => {
  const db = makeGraphDb();
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

test("data_model without dataModelKey falls back to item id", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "dbt:model/orders",
    service: "dbt",
    type: "data_model",
    title: "orders",
    authorId: null,
    metadata: { derivedFromKeys: [] },
  });
  const ent = db
    .query<{ external_id: string }, []>(
      "SELECT external_id FROM graph_entity WHERE type = 'data_model'",
    )
    .get();
  expect(ent?.external_id).toBe("dbt:model/orders");
});

test("data_model with no derivedFromKeys creates no edges", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "dbt:model/sessions",
    service: "dbt",
    type: "data_model",
    title: "sessions",
    authorId: null,
    metadata: { dataModelKey: "analytics.public.sessions" },
  });
  const count = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM graph_relation WHERE type = 'derived_from'",
    )
    .get();
  expect(count?.c).toBe(0);
});

// ---------------------------------------------------------------------------
// Task 5 — syncDashboardGraph
// ---------------------------------------------------------------------------

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

test("dashboard with no upstreamDataModelKeys creates no edges", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "tableau:view/empty",
    service: "tableau",
    type: "dashboard",
    title: "Empty dash",
    authorId: null,
    metadata: {},
  });
  const count = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM graph_relation WHERE type = 'upstream_refs'",
    )
    .get();
  expect(count?.c).toBe(0);
});

// ---------------------------------------------------------------------------
// Task 6 — syncDataQualityTestGraph
// ---------------------------------------------------------------------------

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

test("data_quality_test with no monitoredDataModelKeys creates no edges", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "montecarlo:incident/99",
    service: "montecarlo",
    type: "data_quality_test",
    title: "schema drift alert",
    authorId: null,
    metadata: {},
  });
  const count = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM graph_relation WHERE type = 'monitors'")
    .get();
  expect(count?.c).toBe(0);
});
