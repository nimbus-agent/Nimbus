import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

function seedItem(db: Database, id: string, service: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, ?, 'issue', ?, 't', 1, 1)`,
    [id, service, id],
  );
}

describe("V91 migration - my open work snapshots", () => {
  test("a V90 database gains an empty work_snapshot and the schema constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 90);
      runIndexedSchemaMigrations(db, 91);
      expect(db.query("SELECT count(*) AS n FROM work_snapshot").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 91 });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
    } finally {
      db.close();
    }
  });

  test("the relation CHECK and the primary key hold", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 91);
      const ins = (relation: string, itemId: string) =>
        db.run(
          "INSERT INTO work_snapshot (service, relation, item_id, captured_at) VALUES ('github', ?, ?, 1)",
          [relation, itemId],
        );
      expect(() => ins("bogus", "a")).toThrow();
      ins("assigned", "a");
      ins("review_requested", "a");
      ins("authored_open", "a");
      expect(() => ins("assigned", "a")).toThrow();
    } finally {
      db.close();
    }
  });

  test("deleting an item (one or a whole service) removes its snapshot rows", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 91);
      seedItem(db, "i1", "jira");
      seedItem(db, "i2", "jira");
      seedItem(db, "i3", "linear");
      for (const [svc, id] of [
        ["jira", "i1"],
        ["jira", "i2"],
        ["linear", "i3"],
      ] as const) {
        db.run(
          "INSERT INTO work_snapshot (service, relation, item_id, captured_at) VALUES (?, 'assigned', ?, 1)",
          [svc, id],
        );
      }
      db.run("DELETE FROM item WHERE id = ?", ["i1"]);
      expect(db.query("SELECT item_id FROM work_snapshot ORDER BY item_id").all()).toEqual([
        { item_id: "i2" },
        { item_id: "i3" },
      ]);
      db.run("DELETE FROM item WHERE service = ?", ["jira"]);
      expect(db.query("SELECT item_id FROM work_snapshot").all()).toEqual([{ item_id: "i3" }]);
    } finally {
      db.close();
    }
  });

  test("re-running the step is idempotent", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 91);
      db.run("PRAGMA user_version = 90");
      expect(() => runIndexedSchemaMigrations(db, 91)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
