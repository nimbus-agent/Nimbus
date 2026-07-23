import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";
import { upsertGraphRelation } from "./relationship-graph.ts";

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
