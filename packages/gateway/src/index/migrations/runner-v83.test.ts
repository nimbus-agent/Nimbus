import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { dbRun } from "../../db/write.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

function cols(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("V83 migration — connector write opt-in", () => {
  test("a V82 database migrates to 83 and gains the enablement table", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 82);
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'connector_write_enablement'").all(),
      ).toHaveLength(0);
      runIndexedSchemaMigrations(db, 83);
      expect(cols(db, "connector_write_enablement")).toEqual(["service", "max_wave", "enabled_at"]);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 83 });
    } finally {
      db.close();
    }
  });

  test("the CHECK refuses a wave outside 2, 3, 4", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 83);
      for (const wave of [1, 5]) {
        expect(() =>
          dbRun(
            db,
            "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('github', ?, 1)",
            [wave],
          ),
        ).toThrow();
      }
      dbRun(
        db,
        "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('github', 4, 1)",
      );
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are at least 83", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(83);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
  });
});
