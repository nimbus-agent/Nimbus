import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

describe("V108 warehouse schema history", () => {
  test("the schema constant and the registered chain reach 108", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(108);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("a fresh database has the table, three indexes, no foreign key and no trigger", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    expect(db.query("PRAGMA foreign_key_list(schema_history)").all()).toEqual([]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'schema_history'",
        )
        .all(),
    ).toEqual([]);
    const idx = db.query("PRAGMA index_list(schema_history)").all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name).sort()).toEqual([
      "schema_history_key_time",
      "schema_history_observed",
      "schema_history_table",
    ]);
    db.close();
  });

  test("an upgrade from V107 keeps data and is re-runnable", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 107);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'schema_history'").all()).toEqual(
      [],
    );
    runIndexedSchemaMigrations(db, 108);
    db.run(
      "INSERT INTO schema_history (service, data_model_key, observed_at_ms, complete, column_count, columns_json) VALUES ('snowflake','a.b.c',1,1,0,'[]')",
    );
    db.run("PRAGMA user_version = 107");
    runIndexedSchemaMigrations(db, 108);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 108 });
    expect(db.query("SELECT COUNT(*) AS n FROM schema_history").get()).toEqual({ n: 1 });
    db.close();
  });
});
