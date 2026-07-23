import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function entityTypes(db: Database): string[] {
  const rows = db.query("SELECT DISTINCT type FROM graph_entity ORDER BY type").all() as Array<{
    type: string;
  }>;
  return rows.map((r) => r.type);
}

test("an indexed incident becomes an incident graph entity", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  });

  expect(entityTypes(db)).toContain("incident");
  const row = db
    .query("SELECT external_id, service, label FROM graph_entity WHERE type = 'incident'")
    .get() as { external_id: string; service: string; label: string };
  expect(row.external_id).toBe("pagerduty:PD-1");
  expect(row.service).toBe("pagerduty");
  expect(row.label).toBe("Checkout 500s");
});

test("an indexed deployment becomes a deployment graph entity", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  });

  expect(entityTypes(db)).toContain("deployment");
  const row = db
    .query("SELECT external_id, service FROM graph_entity WHERE type = 'deployment'")
    .get() as { external_id: string; service: string };
  expect(row.external_id).toBe("github:deploy-9");
  expect(row.service).toBe("github");
});

test("an incident with no metadata.service still gets a graph entity with affectedService null", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-2",
    title: "Payments latency spike",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  const row = db
    .query("SELECT metadata FROM graph_entity WHERE type = 'incident' AND external_id = ?")
    .get("pagerduty:PD-2") as { metadata: string };
  const parsed = JSON.parse(row.metadata) as { affectedService: unknown };
  expect(parsed.affectedService).toBeNull();
});

test("occurredAtForItem throws when the populator is called without a backing item row", () => {
  const db = freshDb();
  expect(() =>
    syncGraphFromIndexedItem(db, {
      id: "pagerduty:PD-missing",
      service: "pagerduty",
      type: "incident",
      title: "No backing item row",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    }),
  ).toThrow(/no item row/);
});

test("re-syncing an incident twice does not accumulate duplicate or stale relations", () => {
  const db = freshDb();
  const now = Date.now();
  const item = {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-3",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  };

  upsertIndexedItem(db, item);
  upsertIndexedItem(db, item);

  const entity = db
    .query("SELECT id FROM graph_entity WHERE type = 'incident' AND external_id = ?")
    .get("pagerduty:PD-3") as { id: string };
  const relationCount = db
    .query("SELECT COUNT(*) AS n FROM graph_relation WHERE from_id = ? OR to_id = ?")
    .get(entity.id, entity.id) as { n: number };
  expect(relationCount.n).toBe(0);
});

const HOUR = 60 * 60 * 1000;

function correlations(db: Database): Array<{ from: string; to: string }> {
  return db
    .query(
      `SELECT f.type || ':' || f.external_id AS "from",
              t.type || ':' || t.external_id AS "to"
         FROM graph_relation r
         JOIN graph_entity f ON f.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id
        WHERE r.type = 'correlates_with'
        ORDER BY "from", "to"`,
    )
    .all() as Array<{ from: string; to: string }>;
}

function seedDeploy(db: Database, at: number, service: string): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { service },
  });
}

function seedIncident(db: Database, at: number, service: string): void {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { service },
  });
}

test("an incident shortly after a deploy of the same service correlates", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
  ]);
});

test("correlation is emitted regardless of which side syncs last", () => {
  const db = freshDb();
  const t = Date.now();
  seedIncident(db, t + HOUR, "checkout");
  seedDeploy(db, t, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
  ]);
});

test("an incident outside the window does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + 5 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("an incident before the deploy does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t - HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("a different service does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "search");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident to a different service retires the stale correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident is re-classified against a different service.
  seedIncident(db, t + HOUR, "search");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident out of the window retires the stale correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident's true start time turns out to be much later.
  seedIncident(db, t + 5 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});
