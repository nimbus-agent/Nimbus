import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V34 migration — identity tables", () => {
  test("creates the four identity tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('identity_session','scim_user','identity_binding','oidc_jwks_cache')`,
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      "identity_binding",
      "identity_session",
      "oidc_jwks_cache",
      "scim_user",
    ]);
  });

  test("idx_identity_binding_peer index exists", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const indexes = db
      .query<{ name: string }, []>(`PRAGMA index_list(identity_binding)`)
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_identity_binding_peer");
  });

  test("user_version is at least 34 and V34 is recorded", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const { user_version } = db.query(`PRAGMA user_version`).get() as { user_version: number };
    expect(user_version).toBeGreaterThanOrEqual(34);
    const row = db.query("SELECT description FROM _schema_migrations WHERE version = 34").get() as {
      description: string;
    } | null;
    expect(row?.description).toContain("identity");
  });
});
