import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string; notnull: number; dflt_value: unknown };

const columns = (db: Database): ColRow[] =>
  db.query("PRAGMA table_info(extension)").all() as ColRow[];

describe("V105 extension provenance columns (offline provenance re-verification, slice 2)", () => {
  test("the schema constant and the registered chain end at 105", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(105);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(105);
  });

  test("a fresh database has both columns, nullable with no default", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const cols = columns(db);
    for (const name of ["provenance_json", "provenance_bundle"]) {
      const c = cols.find((r) => r.name === name);
      expect(c).toBeDefined();
      expect(c?.notnull).toBe(0);
      expect(c?.dflt_value).toBeNull();
    }
    db.close();
  });

  test("an upgrade from V104 keeps existing rows, with both columns null", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 104);
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
       VALUES ('com.example.tool', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    );
    runIndexedSchemaMigrations(db, 105);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 105 });
    expect(db.query("SELECT provenance_json, provenance_bundle FROM extension").get()).toEqual({
      provenance_json: null,
      provenance_bundle: null,
    });
    db.close();
  });

  test("the step is re-runnable: a rewound user_version does not add a column twice", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 105);
    db.run("PRAGMA user_version = 104");
    runIndexedSchemaMigrations(db, 105);
    expect(columns(db).filter((c) => c.name.startsWith("provenance_"))).toHaveLength(2);
    db.close();
  });
});
