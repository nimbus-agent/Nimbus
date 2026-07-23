import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function mentionTargets(db: Database): string[] {
  const rows = db
    .query(
      `SELECT e.type || ':' || e.external_id AS ref
         FROM graph_relation r
         JOIN graph_entity e ON e.id = r.to_id
        WHERE r.type = 'mentions'
        ORDER BY ref`,
    )
    .all() as Array<{ ref: string }>;
  return rows.map((r) => r.ref);
}

function seedMessage(db: Database, body: string, at: number): void {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: body,
    bodyPreview: body,
    modifiedAt: at,
    syncedAt: at,
    metadata: { channel: "C1" },
  });
}

test("a message naming a ticket key mentions that issue", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  seedMessage(db, "anyone looking at NIM-88?", now);

  expect(mentionTargets(db)).toEqual(["issue:linear:NIM-88"]);
});

test("a message naming a commit SHA mentions that commit", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "git_commit",
    externalId: "a1b2c3d4e5f6",
    title: "Fix retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha: "a1b2c3d4e5f6", repoRoot: "/repo" },
  });

  seedMessage(db, "this broke in a1b2c3d4e5f6", now);

  expect(mentionTargets(db)).toEqual(["commit:github:a1b2c3d4e5f6"]);
});

test("a message referencing nothing indexed emits no edges", () => {
  const db = freshDb();
  const now = Date.now();
  seedMessage(db, "lunch?", now);
  expect(mentionTargets(db)).toEqual([]);
});

test("editing a message to drop the reference drops the edge", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  seedMessage(db, "anyone looking at NIM-88?", now);
  seedMessage(db, "never mind", now + 1);

  expect(mentionTargets(db)).toEqual([]);
});
