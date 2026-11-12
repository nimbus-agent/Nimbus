import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ITEM_HISTORY_V94_SQL } from "../item-history-v94-sql.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string; notnull: number };

function seedHistory(db: Database, itemId: string, key: string): void {
  db.run(
    `INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms)
     VALUES (?, 'github', 'pr', ?, 'open', 'merged', 10)`,
    [itemId, key],
  );
}

describe("V94 migration - item history", () => {
  test("a V93 database gains an empty item_history and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION - 1);
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT count(*) AS n FROM item_history").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_SCHEMA_VERSION,
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(94);
    } finally {
      db.close();
    }
  });

  test("the columns, nullability and the three indexes are exactly the design", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const cols = db.query("PRAGMA table_info(item_history)").all() as ColRow[];
      expect(cols.map((c) => c.name)).toEqual([
        "id",
        "item_id",
        "service",
        "type",
        "key",
        "old_value",
        "new_value",
        "observed_at_ms",
        "source_at_ms",
      ]);
      const notNull = cols.filter((c) => c.notnull === 1).map((c) => c.name);
      expect(notNull).toEqual(["item_id", "service", "type", "key", "observed_at_ms"]);
      const idx = (db.query("PRAGMA index_list(item_history)").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(idx).toContain("item_history_item");
      expect(idx).toContain("item_history_type");
      expect(idx).toContain("item_history_observed");
    } finally {
      db.close();
    }
  });

  test("there is no foreign key and no trigger: deleting the item keeps its history", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("PRAGMA foreign_key_list(item_history)").all()).toEqual([]);
      const triggers = db
        .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'item_history'")
        .all();
      expect(triggers).toEqual([]);
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
         VALUES ('i1', 'github', 'pr', 'e', 't', 1, 1)`,
      );
      seedHistory(db, "i1", "state");
      seedHistory(db, "i1", "merged");
      db.run("DELETE FROM item");
      expect(db.query("SELECT count(*) AS n FROM item_history").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  test("the batched prune statement is served by item_history_observed", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const sql =
        "DELETE FROM item_history WHERE id IN (SELECT id FROM item_history WHERE observed_at_ms < ? ORDER BY observed_at_ms LIMIT 5000)";
      const plan = (d: Database) => {
        const stmt = d.prepare(`EXPLAIN QUERY PLAN ${sql}`);
        try {
          return (stmt.all(1) as { detail: string }[]).map((r) => r.detail).join("\n");
        } finally {
          stmt.finalize();
        }
      };
      expect(plan(db)).toContain("item_history_observed");
      // Red-prove: without the index the plan cannot mention it.
      db.run("DROP INDEX item_history_observed");
      expect(plan(db)).not.toContain("item_history_observed");
    } finally {
      db.close();
    }
  });

  test("re-running the DDL is idempotent", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      for (const stmt of ITEM_HISTORY_V94_SQL) db.run(stmt);
      expect(db.query("SELECT count(*) AS n FROM item_history").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
