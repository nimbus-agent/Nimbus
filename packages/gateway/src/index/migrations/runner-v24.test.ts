import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V24 migration — audit_log.session_id", () => {
  test("adds session_id column to audit_log", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 24);

    const cols = db.query("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("session_id");
  });

  test("creates idx_audit_log_session_id index", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 24);

    const idx = db
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_log_session_id'`,
      )
      .get();
    expect(idx).not.toBeNull();
  });

  test("old rows inserted before migration have NULL session_id", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 23);

    db.run(
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["test.legacy", "not_required", "{}", 1000, "a".repeat(64), "0".repeat(64)],
    );

    runIndexedSchemaMigrations(db, 24);

    const row = db
      .query(`SELECT session_id FROM audit_log WHERE action_type = 'test.legacy'`)
      .get() as { session_id: string | null } | undefined;
    expect(row?.session_id).toBeNull();
  });

  test("new rows can be inserted with a session_id value", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 24);

    db.run(
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["test.new", "approved", "{}", 2000, "b".repeat(64), "0".repeat(64), "sess-abc-123"],
    );

    const row = db.query(`SELECT session_id FROM audit_log WHERE action_type = 'test.new'`).get() as
      | { session_id: string }
      | undefined;
    expect(row?.session_id).toBe("sess-abc-123");
  });

  test("user_version is set to 24 after migration", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 24);

    const row = db.query("PRAGMA user_version").get() as { user_version: number } | undefined;
    expect(row?.user_version).toBe(24);
  });
});
