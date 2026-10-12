import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V66 migration — extension tree digest", () => {
  test("CURRENT_SCHEMA_VERSION is at least 66", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
  });

  test("an existing V65 extension row gains a NULL tree digest", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 65);
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
       VALUES ('com.example.old', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    );
    runIndexedSchemaMigrations(db, 66);
    const row = db
      .query("SELECT tree_digest FROM extension WHERE id = 'com.example.old'")
      .get() as { tree_digest: string | null };
    expect(row.tree_digest).toBeNull();
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      66,
    );
    db.close();
  });
});
