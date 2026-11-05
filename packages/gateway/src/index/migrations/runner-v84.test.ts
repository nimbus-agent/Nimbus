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

describe("V84 migration — the connector write approved set", () => {
  test("a V83 opt-in migrates with an EMPTY approved set (fail closed until re-enabled)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 83);
      dbRun(
        db,
        "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('github', 2, 1)",
      );
      runIndexedSchemaMigrations(db, 84);
      expect(cols(db, "connector_write_enablement")).toEqual([
        "service",
        "max_wave",
        "enabled_at",
        "approved_tool_ids",
      ]);
      expect(db.query("SELECT approved_tool_ids FROM connector_write_enablement").get()).toEqual({
        approved_tool_ids: "[]",
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 84 });
    } finally {
      db.close();
    }
  });

  test("the column refuses NULL", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 84);
      expect(() =>
        dbRun(
          db,
          "INSERT INTO connector_write_enablement (service, max_wave, enabled_at, approved_tool_ids) VALUES ('github', 2, 1, NULL)",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are at least 84, and agree", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(84);
    expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
  });
});
