import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";
import {
  CAPTURED_RELATION_TYPES,
  graphRelationExists,
  upsertGraphRelation,
} from "./relationship-graph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function relationCount(db: Database, type: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = ?").get(type) as {
    n: number;
  };
  return row.n;
}

test("a cross-item `mentions` edge survives a re-sync of the entity it points at", () => {
  const db = freshDb();
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "patch",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: "shipping acme/app#1 now",
    bodyPreview: "shipping acme/app#1 now",
    modifiedAt: now,
    syncedAt: now,
    metadata: { channel: "C1" },
  });

  const pr = db.query("SELECT id FROM graph_entity WHERE type = 'pr' LIMIT 1").get() as {
    id: string;
  };
  const msg = db.query("SELECT id FROM graph_entity WHERE type = 'message' LIMIT 1").get() as {
    id: string;
  };

  // Stand in for what Task 4 will emit from the message side.
  upsertGraphRelation(db, msg.id, pr.id, "mentions", now);
  expect(relationCount(db, "mentions")).toBe(1);

  // Re-sync the PR. Its own edges are rebuilt; the message's edge must not be collateral.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login (v2)",
    bodyPreview: "patch",
    modifiedAt: now + 1,
    syncedAt: now + 1,
    metadata: { repo: "acme/app" },
  });

  expect(relationCount(db, "mentions")).toBe(1);
});

test("a re-sync still rebuilds the entity's own edges rather than duplicating them", () => {
  const db = freshDb();
  const now = Date.now();

  for (const [i, title] of ["Fix login", "Fix login (v2)"].entries()) {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title,
      bodyPreview: "patch",
      modifiedAt: now + i,
      syncedAt: now + i,
      metadata: { repo: "acme/app" },
    });
  }

  expect(relationCount(db, "targets")).toBe(1);
});

test("the populator receives the item body", () => {
  const db = freshDb();

  // Compiles only once IndexedItemGraphInput carries bodyPreview.
  syncGraphFromIndexedItem(db, {
    id: "github:acme/app#7",
    service: "github",
    type: "pr",
    title: "Fix login",
    bodyPreview: "closes #4",
    authorId: null,
    metadata: { repo: "acme/app" },
  });

  const pr = db.query("SELECT id FROM graph_entity WHERE type = 'pr' LIMIT 1").get() as {
    id: string;
  } | null;
  expect(pr).not.toBeNull();
});

test("a captured_* edge survives a re-sync of either endpoint; a populator-owned edge does not", () => {
  const db = freshDb();
  const now = Date.now();
  const put = (externalId: string, title: string, at: number) =>
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId,
      title,
      bodyPreview: "patch",
      modifiedAt: at,
      syncedAt: at,
      metadata: { repo: "acme/app" },
    });
  put("acme/app#1", "A", now);
  put("acme/app#2", "B", now);
  const idOf = (ext: string): string =>
    (
      db
        .query("SELECT id FROM graph_entity WHERE type = 'pr' AND external_id = ?")
        .get(`github:${ext}`) as { id: string }
    ).id;
  const eA = idOf("acme/app#1");
  const eB = idOf("acme/app#2");

  upsertGraphRelation(db, eA, eB, CAPTURED_RELATION_TYPES.fixes, now);
  // Positive control: a type the populator does NOT exempt, on the same endpoints.
  upsertGraphRelation(db, eA, eB, "authored", now);
  expect(graphRelationExists(db, eA, eB, "authored")).toBe(true);

  put("acme/app#1", "A v2", now + 1);
  put("acme/app#2", "B v2", now + 2);

  expect(graphRelationExists(db, eA, eB, "authored")).toBe(false); // the clear really ran
  expect(graphRelationExists(db, eA, eB, "captured_fixes")).toBe(true);
});
