import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string };

function insertStep(db: Database, status: string, step = 1, sha = "a".repeat(64)): void {
  db.run(
    `INSERT INTO incident_runbook_step (record_id, runbook, runbook_sha256, step, status, action_id, updated_at_ms)
     VALUES ('inc_0000000000000001', 'db-failover', ?, ?, ?, NULL, 1)`,
    [sha, step, status],
  );
}

describe("V104 incident_runbook_step (Phase 10 IC6)", () => {
  test("the schema constant and the registered chain end at 104", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(104);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(104);
  });

  test("a fresh database has the table with the declared columns", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const cols = db.query("PRAGMA table_info(incident_runbook_step)").all() as ColRow[];
    expect(cols.map((c) => c.name)).toEqual([
      "record_id",
      "runbook",
      "runbook_sha256",
      "step",
      "status",
      "action_id",
      "updated_at_ms",
    ]);
    db.close();
  });

  test("an upgrade from V103 reaches 104 and keeps the V103 tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 103);
    runIndexedSchemaMigrations(db, 104);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 104 });
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("incident_finding");
    expect(names).toContain("incident_runbook_step");
    db.close();
  });

  test("the checks refuse a bad status, step and hash, and the key is (record, runbook, step)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    for (const s of ["done", "running", "ok", "denied", "failed"]) {
      db.run("DELETE FROM incident_runbook_step");
      insertStep(db, s);
    }
    expect(() => insertStep(db, "approved", 2)).toThrow();
    expect(() => insertStep(db, "ok", 0)).toThrow();
    expect(() => insertStep(db, "ok", 51)).toThrow();
    expect(() => insertStep(db, "ok", 3, "short")).toThrow();
    expect(() => insertStep(db, "ok", 1)).toThrow();
    db.close();
  });
});
