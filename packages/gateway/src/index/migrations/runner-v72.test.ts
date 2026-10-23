import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V72 migration — extension run-grant credentials", () => {
  test("CURRENT_SCHEMA_VERSION is at least 72", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
  });

  test("V72 adds a NOT NULL credentials_json column defaulting to '{}'", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 72);
      const cols = db.query("PRAGMA table_info(extension_run_grant)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const c = cols.find((x) => x.name === "credentials_json");
      expect(c).toBeDefined();
      expect(c?.notnull).toBe(1);
      expect(c?.dflt_value).toBe("'{}'");
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 72 });
      expect(
        db.query("SELECT version, description FROM _schema_migrations WHERE version = 72").get(),
      ).toEqual({
        version: 72,
        description: "extension run-grant credentials (extension_run_grant.credentials_json)",
      });
    } finally {
      db.close();
    }
  });

  test("an existing grant row reads back with credentials_json = '{}'", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 71);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('com.example.old', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
      );
      db.run(
        `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at)
         VALUES ('com.example.old', 'ext_com_example_old', '1.0.0', 'd', '{}', 0, 1)`,
      );
      runIndexedSchemaMigrations(db, 72);
      expect(
        db
          .query(
            "SELECT credentials_json FROM extension_run_grant WHERE extension_id = 'com.example.old'",
          )
          .get(),
      ).toEqual({ credentials_json: "{}" });
    } finally {
      db.close();
    }
  });
});
