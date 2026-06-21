import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("V44 migration — egress_ledger", () => {
  test("CURRENT_SCHEMA_VERSION is at least 44", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
  });

  test("applies on a V43 DB and creates egress_ledger with the expected columns", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 43);
    expect(columnNames(db, "egress_ledger")).toHaveLength(0); // table absent at V43
    runIndexedSchemaMigrations(db, 44);
    expect(columnNames(db, "egress_ledger")).toEqual(
      expect.arrayContaining([
        "id",
        "timestamp",
        "source_type",
        "source_id",
        "destination",
        "method",
        "payload_summary",
        "hitl_status",
        "result_status",
        "row_hash",
        "prev_hash",
      ]),
    );
    db.close();
  });

  test("is idempotent — re-running to V44 on a V44 DB is a no-op (no throw, no dup rows)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 44);
    db.run(
      `INSERT INTO egress_ledger
        (timestamp, source_type, source_id, destination, method, payload_summary, hitl_status, result_status, row_hash, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        "task",
        "s1",
        "email",
        "email.send",
        "{}",
        "approved",
        "authorized",
        "a".repeat(64),
        "0".repeat(64),
      ],
    );
    runIndexedSchemaMigrations(db, 44); // second run: must skip the step entirely
    const count = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });

  test("the three lookup indexes exist", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 44);
    const idx = (
      db.query(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        "idx_egress_ledger_ts",
        "idx_egress_ledger_source",
        "idx_egress_ledger_dest",
      ]),
    );
    db.close();
  });
});
