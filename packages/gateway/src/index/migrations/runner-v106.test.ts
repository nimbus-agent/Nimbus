import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type ColRow = { name: string; notnull: number; dflt_value: unknown };

const columns = (db: Database): ColRow[] =>
  db.query("PRAGMA table_info(incident_proposal)").all() as ColRow[];

function insertProposal(db: Database, id: string, status: string, undo: string | null): void {
  db.run(
    `INSERT INTO incident_proposal
       (id, record_id, record_version, kind, tool_id, input_json, evidence_json, reversibility,
        status, created_at_ms, expires_at_ms, updated_at_ms, action_id, undo_status)
     VALUES (?, 'inc_0123456789abcdef', 1, 'k', 't', '{}', '{}', 'reversible', ?, 1, 2, 777, ?, ?)`,
    [id, status, `act_${id}`, undo],
  );
}

describe("V106 incident_proposal.executed_at_ms (incident undo with no id)", () => {
  test("the schema constant and the registered chain end at 106", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(106);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(106);
  });

  test("a fresh database has the column, nullable with no default", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const c = columns(db).find((r) => r.name === "executed_at_ms");
    expect(c).toBeDefined();
    expect(c?.notnull).toBe(0);
    expect(c?.dflt_value).toBeNull();
    db.close();
  });

  test("an upgrade from V105 backfills only executed rows that were never undone", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 105);
    insertProposal(db, "a", "executed", null);
    insertProposal(db, "b", "executed", "undone");
    insertProposal(db, "c", "proposed", null);
    runIndexedSchemaMigrations(db, 106);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 106 });
    const rows = db.query("SELECT id, executed_at_ms FROM incident_proposal ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", executed_at_ms: 777 },
      { id: "b", executed_at_ms: null },
      { id: "c", executed_at_ms: null },
    ]);
    db.close();
  });

  test("the step is re-runnable: a rewound user_version does not add the column twice", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 106);
    db.run("PRAGMA user_version = 105");
    runIndexedSchemaMigrations(db, 106);
    expect(columns(db).filter((c) => c.name === "executed_at_ms")).toHaveLength(1);
    db.close();
  });
});
