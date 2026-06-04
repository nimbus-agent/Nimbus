import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V33 migration — federation tables", () => {
  test("creates the three federation tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 33);
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'federation_%'`,
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      "federation_grants",
      "federation_namespace_filters",
      "federation_namespaces",
    ]);
  });

  test("audit_log has the federation_json column", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 33);
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(audit_log)`)
      .all()
      .map((r) => r.name);
    expect(cols).toContain("federation_json");
  });

  test("idx_fed_filters_ns index exists on federation_namespace_filters", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 33);
    const indexes = db
      .query<{ name: string }, []>(`PRAGMA index_list(federation_namespace_filters)`)
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_fed_filters_ns");
  });

  test("idx_fed_grants_peer index exists on federation_grants", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 33);
    const indexes = db
      .query<{ name: string }, []>(`PRAGMA index_list(federation_grants)`)
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_fed_grants_peer");
  });

  test("user_version is at least 33", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 33);
    const { user_version } = db.query(`PRAGMA user_version`).get() as {
      user_version: number;
    };
    expect(user_version).toBeGreaterThanOrEqual(33);
  });

  test("V33 records an applied row in _schema_migrations", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 33);
    const row = db
      .query("SELECT version, description FROM _schema_migrations WHERE version = 33")
      .get() as { version: number; description: string } | null;
    expect(row?.version).toBe(33);
    expect(row?.description).toContain("federation");
  });
});
