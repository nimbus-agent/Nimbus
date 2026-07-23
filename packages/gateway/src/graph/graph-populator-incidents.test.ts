import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

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
    .query("SELECT external_id, service FROM graph_entity WHERE type = 'incident'")
    .get() as { external_id: string; service: string };
  expect(row.external_id).toBe("pagerduty:PD-1");
  expect(row.service).toBe("pagerduty");
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
});
