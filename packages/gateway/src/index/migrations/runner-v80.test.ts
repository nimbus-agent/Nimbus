import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

describe("V80 migration — registry_liveness_state", () => {
  test("a V79 database migrates to 80 and has exactly the floor columns", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 79);
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'registry_liveness_state'").all(),
      ).toHaveLength(0);
      runIndexedSchemaMigrations(db, 80);
      const cols = (
        db.query("PRAGMA table_info(registry_liveness_state)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toEqual([
        "registry",
        "liveness_key",
        "last_sequence",
        "last_document_sha256",
        "last_generated_at",
        "last_fetched_at",
      ]);
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are 80", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBe(80);
    expect(CURRENT_SCHEMA_VERSION).toBe(80);
  });
});
