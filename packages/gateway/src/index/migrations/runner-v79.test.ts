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

type Column = { name: string; notnull: number; dflt_value: string | null };

function columns(db: Database, table: string): Column[] {
  return db.query(`PRAGMA table_info(${table})`).all() as Column[];
}

describe("V79 migration — extension.kind", () => {
  test("CURRENT_SCHEMA_VERSION is at least 79", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(79);
  });

  test("V79 adds extension.kind defaulting to extension", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 78);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('x','1.0.0','/p','m','e',1,1,1)`,
      );
      runIndexedSchemaMigrations(db, 79);
      const col = columns(db, "extension").find((c) => c.name === "kind");
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value).toBe("'extension'");
      expect(db.query("SELECT kind AS k FROM extension").get()).toEqual({ k: "extension" });
    });
  });

  test("kind accepts only extension or starter-pack", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 79);
      const insert = (id: string, kind: string) =>
        db.run(
          `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, kind)
           VALUES (?, '1.0.0', '/p', 'm', 'e', 1, 1, 1, ?)`,
          [id, kind],
        );
      insert("pack", "starter-pack");
      expect(db.query("SELECT kind AS k FROM extension WHERE id = 'pack'").get()).toEqual({
        k: "starter-pack",
      });
      expect(() => insert("bad", "pack")).toThrow();
    });
  });

  test("is idempotent with the ledger", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 79);
      runIndexedSchemaMigrations(db, 79);
      expect(columns(db, "extension").filter((c) => c.name === "kind")).toHaveLength(1);
    });
  });
});
