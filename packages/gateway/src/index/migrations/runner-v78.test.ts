import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function withDb(fn: (db: Database) => void): void {
  const db = new Database(":memory:");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

type Column = { name: string; notnull: number };

function columns(db: Database, table: string): Column[] {
  return db.query(`PRAGMA table_info(${table})`).all() as Column[];
}

describe("V78 migration — dependency edge registry and marker", () => {
  test("CURRENT_SCHEMA_VERSION is at least 78", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(78);
  });

  test("adds depends_on_registry as nullable", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 77);
      db.run(
        "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES ('a','b','^1',1)",
      );
      runIndexedSchemaMigrations(db, 78);
      const col = columns(db, "extension_dependency").find((c) => c.name === "depends_on_registry");
      expect(col?.notnull).toBe(0);
      expect(db.query("SELECT depends_on_registry AS r FROM extension_dependency").get()).toEqual({
        r: null,
      });
    });
  });

  test("adds installed_as_dependency defaulting to 0", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 77);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('x','1.0.0','/p','m','e',1,1,1)`,
      );
      runIndexedSchemaMigrations(db, 78);
      expect(db.query("SELECT installed_as_dependency AS d FROM extension").get()).toEqual({
        d: 0,
      });
    });
  });

  test("is idempotent with the ledger", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 78);
      runIndexedSchemaMigrations(db, 78);
      expect(
        columns(db, "extension_dependency").filter((c) => c.name === "depends_on_registry"),
      ).toHaveLength(1);
    });
  });
});
