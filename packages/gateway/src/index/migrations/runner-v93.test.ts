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

function run(db: Database, id: string, firedBy: string, status: string, slot: number | null) {
  db.run(
    "INSERT INTO briefing_run (id, fired_at, fired_by, status, headline, slot_at) VALUES (?, 1, ?, ?, 'h', ?)",
    [id, firedBy, status, slot],
  );
}

describe("V93 migration - morning briefing runs and deadline notices", () => {
  test("a V91 database gains empty briefing_run and deadline_notice and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION - 2);
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT count(*) AS n FROM briefing_run").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM deadline_notice").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_SCHEMA_VERSION,
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(93);
    } finally {
      db.close();
    }
  });

  test("the fired_by and status CHECKs hold, and there is no trigger column", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(() => run(db, "a", "bogus", "ok", null)).toThrow();
      expect(() => run(db, "b", "manual", "bogus", null)).toThrow();
      run(db, "c", "schedule", "ok", 5);
      run(db, "d", "manual", "failed", null);
      const cols = db.query("PRAGMA table_info(briefing_run)").all() as { name: string }[];
      expect(cols.map((c) => c.name)).not.toContain("trigger");
      expect(cols.map((c) => c.name)).toContain("fired_by");
    } finally {
      db.close();
    }
  });

  test("the partial UNIQUE slot index refuses a repeated slot and accepts any number of NULLs", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      run(db, "a", "schedule", "ok", 100);
      expect(() => run(db, "b", "schedule", "skipped", 100)).toThrow();
      run(db, "c", "manual", "ok", null);
      run(db, "d", "manual", "ok", null);
      expect(db.query("SELECT count(*) AS n FROM briefing_run").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  test("deadline_notice primary key holds", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      db.run("INSERT INTO deadline_notice (item_id, due_at_ms, notified_at) VALUES ('x', 1, 1)");
      expect(() =>
        db.run("INSERT INTO deadline_notice (item_id, due_at_ms, notified_at) VALUES ('x', 2, 2)"),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("deleting an item (one or a whole service) removes its notice and no other", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      seedItem(db, "i1", "jira");
      seedItem(db, "i2", "jira");
      seedItem(db, "i3", "linear");
      for (const id of ["i1", "i2", "i3"]) {
        db.run("INSERT INTO deadline_notice (item_id, due_at_ms, notified_at) VALUES (?, 1, 1)", [
          id,
        ]);
      }
      db.run("DELETE FROM item WHERE id = ?", ["i1"]);
      expect(db.query("SELECT item_id FROM deadline_notice ORDER BY item_id").all()).toEqual([
        { item_id: "i2" },
        { item_id: "i3" },
      ]);
      db.run("DELETE FROM item WHERE service = ?", ["jira"]);
      expect(db.query("SELECT item_id FROM deadline_notice").all()).toEqual([{ item_id: "i3" }]);
    } finally {
      db.close();
    }
  });

  test("re-running the step is idempotent", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      run(db, "a", "manual", "ok", null);
      db.run("PRAGMA user_version = 91");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT count(*) AS n FROM briefing_run").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
