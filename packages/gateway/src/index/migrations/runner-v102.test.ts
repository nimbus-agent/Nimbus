import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string; type: string; notnull: number };

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function insertProposal(
  db: Database,
  over: {
    status?: string;
    rev?: string;
    conf?: number | null;
    undo?: string | null;
    id?: string;
    action?: string | null;
  },
): void {
  db.run(
    `INSERT INTO incident_proposal (id, record_id, record_version, kind, tool_id, input_json, evidence_json,
       confidence, reversibility, status, created_at_ms, expires_at_ms, updated_at_ms, action_id, undo_status)
     VALUES (?, 'inc_a', 1, 'ack', 'pd_incident_acknowledge', '{}', '{}', ?, ?, ?, 1, 2, 1, ?, ?)`,
    [
      over.id ?? "prp_a",
      over.conf === undefined ? null : over.conf,
      over.rev ?? "unknown",
      over.status ?? "proposed",
      over.action === undefined ? null : over.action,
      over.undo === undefined ? null : over.undo,
    ],
  );
}

describe("V102 incident_proposal and incident_engine_state (Phase 10 IC5a)", () => {
  test("the schema constant and the registered chain reach 102", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(102);
    expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(102);
  });

  test("a fresh database has both tables with the declared columns", () => {
    const db = migrated();
    const cols = db.query("PRAGMA table_info(incident_proposal)").all() as ColRow[];
    expect(cols.map((c) => c.name)).toEqual([
      "id",
      "record_id",
      "record_version",
      "kind",
      "tool_id",
      "input_json",
      "evidence_json",
      "confidence",
      "reversibility",
      "status",
      "created_at_ms",
      "expires_at_ms",
      "updated_at_ms",
      "action_id",
      "captured_json",
      "undo_status",
      "undone_at_ms",
    ]);
    const state = db.query("PRAGMA table_info(incident_engine_state)").all() as ColRow[];
    expect(state.map((c) => c.name)).toEqual(["key", "value", "updated_at_ms"]);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    db.close();
  });

  test("an upgrade from V100 reaches 102 through the reserved V101 step", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 100);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 100 });
    runIndexedSchemaMigrations(db, 102);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 102 });
    insertProposal(db, {});
    db.close();
  });

  test("the CHECK constraints reject a bad status, reversibility, confidence and undo state", () => {
    const db = migrated();
    expect(() => insertProposal(db, { status: "done" })).toThrow();
    expect(() => insertProposal(db, { rev: "maybe" })).toThrow();
    expect(() => insertProposal(db, { conf: 101 })).toThrow();
    expect(() => insertProposal(db, { undo: "half" })).toThrow();
    insertProposal(db, { conf: 100, undo: "undone", status: "executed", action: "act_1" });
    db.close();
  });

  test("action_id is unique, so one action id names one proposal", () => {
    const db = migrated();
    insertProposal(db, { id: "prp_a", action: "act_1" });
    expect(() => insertProposal(db, { id: "prp_b", action: "act_1" })).toThrow();
    insertProposal(db, { id: "prp_c" });
    insertProposal(db, { id: "prp_d" });
    db.close();
  });

  test("re-running the step is harmless", () => {
    const db = migrated();
    db.run("PRAGMA user_version = 101");
    runIndexedSchemaMigrations(db, 102);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 102 });
    db.close();
  });
});
