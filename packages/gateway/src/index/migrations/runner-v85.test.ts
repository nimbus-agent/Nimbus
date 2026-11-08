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

describe("V85 migration — the iac approved-directory grants", () => {
  test("a V84 database migrates and gains the empty grant table (nothing approved)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 84);
      runIndexedSchemaMigrations(db, 85);
      expect(cols(db, "connector_write_iac_grant")).toEqual(["kind", "value", "approved_at"]);
      expect(db.query("SELECT COUNT(*) AS n FROM connector_write_iac_grant").get()).toEqual({
        n: 0,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 85 });
    } finally {
      db.close();
    }
  });

  test("the kind is closed and a (kind, value) pair is unique", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 85);
      const ins = (kind: string, value: string): unknown =>
        dbRun(
          db,
          "INSERT INTO connector_write_iac_grant (kind, value, approved_at) VALUES (?, ?, 1)",
          [kind, value],
        );
      ins("workdir", "/a");
      ins("cloud", "aws");
      expect(() => ins("workdir", "/a")).toThrow();
      expect(() => ins("secret", "x")).toThrow();
      expect(() =>
        dbRun(
          db,
          "INSERT INTO connector_write_iac_grant (kind, value, approved_at) VALUES ('net', NULL, 1)",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are at least 85, and agree", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(85);
    expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
  });
});
