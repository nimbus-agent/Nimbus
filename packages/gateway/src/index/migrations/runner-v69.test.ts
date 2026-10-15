import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function insertExtension(db: Database, id: string): void {
  db.run(
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
     VALUES (?, '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    [id],
  );
}

function insertGrant(db: Database, extId: string, serviceId: string, model = 0): void {
  db.run(
    `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at)
     VALUES (?, ?, '1.0.0', 'd', '{}', ?, 1)`,
    [extId, serviceId, model],
  );
}

describe("V69 migration — extension run grants", () => {
  test("CURRENT_SCHEMA_VERSION is at least 69", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(69);
  });

  test("creates the table; existing extensions start with no grant", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    insertExtension(db, "com.example.old");
    runIndexedSchemaMigrations(db, 69);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM extension_run_grant").get() as { n: number }).n,
    ).toBe(0);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      69,
    );
    db.close();
  });

  test("service ids are unique, model_access is 0/1, and the grant cascades with its extension", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runIndexedSchemaMigrations(db, 69);
    insertExtension(db, "a");
    insertExtension(db, "b");
    insertGrant(db, "a", "ext_a");
    expect(() => insertGrant(db, "b", "ext_a")).toThrow();
    expect(() => insertGrant(db, "b", "ext_b", 2)).toThrow();
    expect(() => insertGrant(db, "missing", "ext_missing")).toThrow();
    db.run("DELETE FROM extension WHERE id = 'a'");
    expect(
      (db.query("SELECT COUNT(*) AS n FROM extension_run_grant").get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });
});
