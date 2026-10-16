import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V70 migration — extension run grants", () => {
  test("CURRENT_SCHEMA_VERSION is at least 70", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
  });

  test("an existing V69 extension row survives and has no grant", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 69);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('com.example.old', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
      );
      runIndexedSchemaMigrations(db, 70);
      expect(db.query("SELECT COUNT(*) AS n FROM extension").get()).toEqual({ n: 1 });
      expect(db.query("SELECT COUNT(*) AS n FROM extension_run_grant").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 70 });
    } finally {
      db.close();
    }
  });

  test("service_id is UNIQUE and model_access is 0 or 1", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 70);
      const ins = (ext: string, sid: string, model: number): void => {
        db.run(
          `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at)
           VALUES (?, ?, '1.0.0', 'd', '{}', ?, 1)`,
          [ext, sid, model],
        );
      };
      ins("a", "ext_a", 0);
      expect(() => ins("b", "ext_a", 0)).toThrow();
      expect(() => ins("c", "ext_c", 2)).toThrow();
    } finally {
      db.close();
    }
  });
});
