import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

test("V48 adds item.body and item.body_complete", () => {
  const db = migrated();
  const cols = (db.query("PRAGMA table_info(item)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(cols).toContain("body");
  expect(cols).toContain("body_complete");
  db.close();
});

test("V48 points item_fts at body, not body_preview", () => {
  const db = migrated();
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='item_fts'")
    .get() as { sql: string } | null;
  expect(row?.sql).toContain("body");
  expect(row?.sql).not.toContain("body_preview");
  db.close();
});

test("V48 defaults body_complete to 0 for a freshly inserted row", () => {
  const db = migrated();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, modified_at, synced_at)
     VALUES ('slack:1','slack','message','1','t','hello',1,1)`,
  );
  const row = db.query("SELECT body_complete FROM item WHERE id='slack:1'").get() as {
    body_complete: number;
  };
  expect(row.body_complete).toBe(0);
  db.close();
});

test("V48 preserves keyword coverage for rows indexed before the upgrade", () => {
  // The regression this guards: rebuilding item_fts against a NULL `body`
  // would drop every pre-existing row's coverage down to its title alone.
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 47);

  const haystack = `${"filler ".repeat(50)}kumquat ${"filler ".repeat(10)}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES ('slack:1','slack','message','1','a title',?,1,1)`,
    [haystack.slice(0, 512)],
  );

  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

  const hits = db
    .query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'kumquat'")
    .all() as Array<{ rowid: number }>;
  expect(hits).toHaveLength(1);

  const migrate = db.query("SELECT body FROM item WHERE id='slack:1'").get() as {
    body: string | null;
  };
  expect(migrate.body).toBe(haystack.slice(0, 512));
  db.close();
});

test("V48 keeps the fts triggers in sync on insert, update and delete", () => {
  const db = migrated();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, modified_at, synced_at)
     VALUES ('slack:1','slack','message','1','t','alpha',1,1)`,
  );
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'alpha'").all()).toHaveLength(1);

  db.run("UPDATE item SET body = 'bravo' WHERE id='slack:1'");
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'alpha'").all()).toHaveLength(0);
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'bravo'").all()).toHaveLength(1);

  db.run("DELETE FROM item WHERE id='slack:1'");
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'bravo'").all()).toHaveLength(0);
  db.close();
});
