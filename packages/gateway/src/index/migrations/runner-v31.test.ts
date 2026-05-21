import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V31 migration — extension_dependency table", () => {
  test("creates the table + reverse-dep index", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 31);
    const tableInfo = db.query("PRAGMA table_info(extension_dependency)").all() as Array<{
      name: string;
      type: string;
    }>;
    expect(tableInfo.map((c) => c.name).sort()).toEqual(
      ["created_at", "depends_on_id", "extension_id", "range"].sort(),
    );

    const indexInfo = db.query("PRAGMA index_list(extension_dependency)").all() as Array<{
      name: string;
    }>;
    expect(indexInfo.some((i) => i.name === "idx_extension_dependency_reverse")).toBe(true);
  });

  test("primary key is (extension_id, depends_on_id)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 31);
    db.run(
      "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
      ["com.example.foo", "com.shared.utils", "^1.0.0", 1],
    );
    expect(() =>
      db.run(
        "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
        ["com.example.foo", "com.shared.utils", "^2.0.0", 2],
      ),
    ).toThrow(/UNIQUE/);
  });

  test("reverse-dep query uses the index", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 31);
    db.run(
      "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
      ["com.example.foo", "com.shared.utils", "^1.0.0", 1],
    );
    db.run(
      "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
      ["com.example.bar", "com.shared.utils", "^2.0.0", 2],
    );
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT extension_id, range FROM extension_dependency WHERE depends_on_id = ?",
      )
      .all("com.shared.utils") as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_extension_dependency_reverse"))).toBe(true);
  });

  test("V31 records an applied row in _schema_migrations", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 31);
    const row = db
      .query("SELECT version, description, applied_at FROM _schema_migrations WHERE version = 31")
      .get() as { version: number; description: string; applied_at: number } | null;
    expect(row?.version).toBe(31);
    expect(row?.description).toContain("extension_dependency");
    expect(row?.applied_at).toBeGreaterThan(0);
  });
});
