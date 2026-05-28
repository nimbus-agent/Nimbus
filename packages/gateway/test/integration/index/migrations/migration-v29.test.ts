import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readIndexedUserVersion,
  runIndexedSchemaMigrations,
} from "../../../../src/index/migrations/runner.ts";

describe("V29 — tool_call_log audit table migration", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-v29-"));
    dbPath = join(tmpDir, "nimbus.db");
    db = new Database(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("PRAGMA user_version reaches 29 after running migrations through V29", () => {
    runIndexedSchemaMigrations(db, 29);
    expect(readIndexedUserVersion(db)).toBe(29);
  });

  test("_schema_migrations records V29 with the correct description", () => {
    runIndexedSchemaMigrations(db, 29);
    const row = db
      .query("SELECT version, description FROM _schema_migrations WHERE version = 29")
      .get() as { version: number; description: string } | null;
    expect(row).not.toBeNull();
    expect(row?.version).toBe(29);
    expect(row?.description).toContain("tool_call_log");
  });

  test("tool_call_log table exists with the expected columns", () => {
    runIndexedSchemaMigrations(db, 29);
    const cols = db.query("PRAGMA table_info(tool_call_log)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));
    expect(colMap.get("id")?.type).toBe("INTEGER");
    expect(colMap.get("session_id")?.notnull).toBe(0);
    expect(colMap.get("tool_id")?.notnull).toBe(1);
    expect(colMap.get("service")?.notnull).toBe(1);
    expect(colMap.get("called_at")?.notnull).toBe(1);
    expect(colMap.get("duration_ms")?.notnull).toBe(1);
    expect(colMap.get("result_envelope")?.notnull).toBe(1);
    expect(colMap.get("status")?.notnull).toBe(1);
  });

  test("the three expected indexes exist", () => {
    runIndexedSchemaMigrations(db, 29);
    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tool_call_log' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name).sort();
    expect(names).toEqual([
      "idx_tool_call_log_called_at",
      "idx_tool_call_log_session",
      "idx_tool_call_log_tool_time",
    ]);
  });

  test("pre-migration backup is written when backupOptions is provided", () => {
    runIndexedSchemaMigrations(db, 28);
    expect(readIndexedUserVersion(db)).toBe(28);

    const backupDir = join(tmpDir, "backups");
    runIndexedSchemaMigrations(db, 29, { backupDir, dbPath });

    const entries = readdirSync(backupDir);
    const v29Backup = entries.find(
      (n) => n.startsWith("pre-migration-29-") && n.endsWith(".db.gz"),
    );
    expect(v29Backup).toBeDefined();
  });

  test("status CHECK constraint rejects values outside ('ok','error')", () => {
    runIndexedSchemaMigrations(db, 29);
    expect(() =>
      db
        .query(
          "INSERT INTO tool_call_log (tool_id, service, called_at, duration_ms, result_envelope, status) VALUES ('t', 's', 0, 0, 'e', 'maybe')",
        )
        .run(),
    ).toThrow();
  });
});
