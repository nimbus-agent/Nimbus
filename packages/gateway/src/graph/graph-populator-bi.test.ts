/**
 * Tests for the data-warehouse/BI lineage handlers in graph-populator.ts:
 *   syncDataModelGraph   — derived_from edges
 *   syncDashboardGraph   — upstream_refs edges
 *   syncDataQualityTestGraph — monitors edges
 *
 * We seed the V40 relation types directly so each test is self-contained
 * and independent of the migration runner.
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
  // Seed V40 relation types directly; keeps tests self-contained.
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
    bodyPreview: null,
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
    bodyPreview: null,
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
    bodyPreview: null,
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
    bodyPreview: null,
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
    bodyPreview: null,
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
    bodyPreview: null,
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
    bodyPreview: null,
    authorId: null,
    metadata: {},
  });
  const count = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM graph_relation WHERE type = 'monitors'")
    .get();
  expect(count?.c).toBe(0);
});

// ---------------------------------------------------------------------------
// Re-sync / stale-edge replacement
// ---------------------------------------------------------------------------

test("re-syncing data_model replaces stale derived_from edges (no leak)", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "dbt:model/orders",
    service: "dbt",
    type: "data_model",
    title: "orders",
    bodyPreview: null,
    authorId: null,
    metadata: { dataModelKey: "db.schema.orders", derivedFromKeys: ["old.upstream"] },
  });
  syncGraphFromIndexedItem(db, {
    id: "dbt:model/orders",
    service: "dbt",
    type: "data_model",
    title: "orders",
    bodyPreview: null,
    authorId: null,
    metadata: { dataModelKey: "db.schema.orders", derivedFromKeys: ["new.upstream"] },
  });
  const rels = db
    .query<{ to_ext: string }, []>(
      `SELECT g.external_id AS to_ext FROM graph_relation r
       JOIN graph_entity f ON f.id = r.from_id AND f.external_id = 'db.schema.orders'
       JOIN graph_entity g ON g.id = r.to_id
       WHERE r.type = 'derived_from'`,
    )
    .all();
  expect(rels).toHaveLength(1);
  expect(rels[0]?.to_ext).toBe("new.upstream");
});

// ---------------------------------------------------------------------------
// Bug 1 — cross-connector edges survive a data_model re-sync
// ---------------------------------------------------------------------------

test("upstream_refs edge survives a data_model re-sync (cross-connector edge not wiped)", () => {
  const db = makeGraphDb();
  // Step 1: tableau syncs a dashboard with upstream = "a.b.c" → creates upstream_refs edge
  syncGraphFromIndexedItem(db, {
    id: "tableau:view/dash1",
    service: "tableau",
    type: "dashboard",
    title: "Dash 1",
    bodyPreview: null,
    authorId: null,
    metadata: { upstreamDataModelKeys: ["a.b.c"] },
  });
  // Verify the upstream_refs edge is present
  const beforeEdge = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity f ON f.id = r.from_id AND f.external_id = 'a.b.c'
       JOIN graph_entity g ON g.id = r.to_id   AND g.type = 'dashboard'`,
    )
    .get();
  expect(beforeEdge?.t).toBe("upstream_refs");

  // Step 2: snowflake re-syncs the data_model "a.b.c" — must NOT wipe the upstream_refs edge
  syncGraphFromIndexedItem(db, {
    id: "snowflake:a.b.c",
    service: "snowflake",
    type: "data_model",
    title: "a.b.c",
    bodyPreview: null,
    authorId: null,
    metadata: { dataModelKey: "a.b.c", derivedFromKeys: [] },
  });
  syncGraphFromIndexedItem(db, {
    id: "snowflake:a.b.c",
    service: "snowflake",
    type: "data_model",
    title: "a.b.c",
    bodyPreview: null,
    authorId: null,
    metadata: { dataModelKey: "a.b.c", derivedFromKeys: [] },
  });

  // The upstream_refs edge written by tableau must still exist
  const afterEdge = db
    .query<{ t: string }, []>(
      `SELECT r.type AS t FROM graph_relation r
       JOIN graph_entity f ON f.id = r.from_id AND f.external_id = 'a.b.c'
       JOIN graph_entity g ON g.id = r.to_id   AND g.type = 'dashboard'`,
    )
    .get();
  expect(afterEdge?.t).toBe("upstream_refs");
});

// ---------------------------------------------------------------------------
// Bug 2 — reference stubs must not clobber the real node's service
// ---------------------------------------------------------------------------

test("tableau upstream reference does not overwrite service of a snowflake-owned data_model node", () => {
  const db = makeGraphDb();
  // Step 1: snowflake creates the authoritative data_model node
  syncGraphFromIndexedItem(db, {
    id: "snowflake:a.b.c",
    service: "snowflake",
    type: "data_model",
    title: "a.b.c",
    bodyPreview: null,
    authorId: null,
    metadata: { dataModelKey: "a.b.c", derivedFromKeys: [] },
  });
  const before = db
    .query<{ service: string | null }, []>(
      "SELECT service FROM graph_entity WHERE external_id = 'a.b.c' AND type = 'data_model'",
    )
    .get();
  expect(before?.service).toBe("snowflake");

  // Step 2: tableau references "a.b.c" as upstream — stub must not overwrite service
  syncGraphFromIndexedItem(db, {
    id: "tableau:view/dash1",
    service: "tableau",
    type: "dashboard",
    title: "Dash 1",
    bodyPreview: null,
    authorId: null,
    metadata: { upstreamDataModelKeys: ["a.b.c"] },
  });
  const after = db
    .query<{ service: string | null }, []>(
      "SELECT service FROM graph_entity WHERE external_id = 'a.b.c' AND type = 'data_model'",
    )
    .get();
  expect(after?.service).toBe("snowflake");
});

// ---------------------------------------------------------------------------
// stringArrayField — non-string filtering
// ---------------------------------------------------------------------------

test("stringArrayField drops non-string entries in monitoredDataModelKeys", () => {
  const db = makeGraphDb();
  syncGraphFromIndexedItem(db, {
    id: "bigeye:monitor/1",
    service: "bigeye",
    type: "data_quality_test",
    title: "mixed array test",
    bodyPreview: null,
    authorId: null,
    metadata: { monitoredDataModelKeys: ["analytics.public.revenue", 42, null, true] },
  });
  const count = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM graph_relation WHERE type = 'monitors'")
    .get();
  expect(count?.c).toBe(1);
});
