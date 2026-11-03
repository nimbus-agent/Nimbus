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

describe("V82 migration — extension observation notice", () => {
  test("a V81 database migrates to 82 and gains the notice table", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 81);
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE name = 'extension_observation_notice'")
          .all(),
      ).toHaveLength(0);
      runIndexedSchemaMigrations(db, 82);
      expect(cols(db, "extension_observation_notice")).toEqual([
        "extension_id",
        "version",
        "last_notified_at",
      ]);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 82 });
    } finally {
      db.close();
    }
  });

  test("a notice cascades with its extension row", () => {
    const db = new Database(":memory:");
    try {
      dbRun(db, "PRAGMA foreign_keys = ON");
      runIndexedSchemaMigrations(db, 82);
      dbRun(
        db,
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('com.example.a', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
      );
      dbRun(
        db,
        "INSERT INTO extension_observation_notice (extension_id, version, last_notified_at) VALUES ('com.example.a', '1.0.0', 5)",
      );
      dbRun(db, "DELETE FROM extension WHERE id = 'com.example.a'");
      expect(db.query("SELECT * FROM extension_observation_notice").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are 82", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBe(82);
    expect(CURRENT_SCHEMA_VERSION).toBe(82);
  });
});
