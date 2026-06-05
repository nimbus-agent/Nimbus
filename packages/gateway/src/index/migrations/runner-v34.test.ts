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

  test("identity_session has the expected columns", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(identity_session)`)
      .all()
      .map((r) => r.name)
      .sort(byName);
    expect(cols).toEqual(
      [
        "claims_json",
        "email",
        "expires_at",
        "external_id",
        "issuer",
        "status",
        "validated_at",
      ].sort(byName),
    );
  });

  test("identity_binding.bound_by CHECK rejects an invalid source", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    expect(() =>
      db.run(
        `INSERT INTO identity_binding (external_id, peer_id, bound_at, bound_by) VALUES ('u1','peer:a',1,'bogus')`,
      ),
    ).toThrow();
    // a valid source is accepted
    db.run(
      `INSERT INTO identity_binding (external_id, peer_id, bound_at, bound_by) VALUES ('u1','peer:a',1,'admin')`,
    );
    const n = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM identity_binding`).get();
    expect(n?.c).toBe(1);
  });

  test("identity_session.status CHECK rejects a value outside the known enum (fail-closed)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const insert = (status: string): void => {
      db.run(
        `INSERT INTO identity_session (issuer, external_id, validated_at, expires_at, status)
         VALUES ('https://acme', 'u1', 0, 1, ?)`,
        [status],
      );
    };
    expect(() => insert("bogus")).toThrow();
    insert("deprovisioned"); // a known value is accepted
    const n = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM identity_session`).get();
    expect(n?.c).toBe(1);
  });
});
