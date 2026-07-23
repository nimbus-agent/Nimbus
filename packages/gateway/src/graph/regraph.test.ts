import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { regraphAllItems } from "./regraph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Insert an item directly, bypassing the populator, to simulate pre-existing data. */
function insertRawItem(
  db: Database,
  o: { service: string; type: string; externalId: string; title: string; body: string; at: number },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      `${o.service}:${o.externalId}`,
      o.service,
      o.type,
      o.externalId,
      o.title,
      o.body,
      o.at,
      o.at,
      JSON.stringify({ repo: "acme/app" }),
    ],
  );
}

test("backfill graphs items that were indexed before the populator knew how", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });

  expect((db.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number }).n).toBe(0);

  const result = regraphAllItems(db);

  expect(result.scanned).toBe(2);
  expect(result.graphed).toBe(2);
  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

test("backfill skips item types the graph does not participate in", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "gdrive",
    type: "file",
    externalId: "f1",
    title: "Notes",
    body: "",
    at: now,
  });

  const result = regraphAllItems(db);
  expect(result.scanned).toBe(1);
  expect(result.graphed).toBe(0);
});

test("backfill is idempotent", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });

  regraphAllItems(db);
  regraphAllItems(db);

  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

test("one pass settles a forward reference that sorts the wrong way by id", () => {
  const db = freshDb();
  const now = Date.now();

  // `github:acme/app#1` (the PR) sorts BEFORE `github:acme/app#4` (the issue),
  // so an id-ordered backfill processes the PR while the issue entity does not
  // yet exist and emits nothing. Type ordering is what makes one pass enough.
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });

  regraphAllItems(db);

  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});
