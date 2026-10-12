import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 67);
  return db;
}

const INSERT =
  "INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

describe("V67 migration — capture sink queue", () => {
  test("CURRENT_SCHEMA_VERSION is at least 67", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
  });

  test("applies on a V66 database and sets user_version", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 66);
    runIndexedSchemaMigrations(db, 67);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      67,
    );
    db.close();
  });

  test("the item_id lookup is indexed (gate step 6 runs it per relatesTo id)", () => {
    const db = migrated();
    const plan = db
      .query("EXPLAIN QUERY PLAN SELECT state FROM capture WHERE item_id = ?")
      .all("nimbus:cap_1") as Array<{ detail: string }>;
    expect(plan.some((r) => r.detail.includes("idx_capture_item_id"))).toBe(true);
    db.close();
  });

  test("a live note with a payload is accepted", () => {
    const db = migrated();
    db.run(INSERT, ["cap_1", "note", "live", "nimbus:cap_1", "{}", 2, "x", "s1", 1]);
    expect(db.query("SELECT state FROM capture WHERE id = 'cap_1'").get()).toEqual({
      state: "live",
    });
    db.close();
  });

  test.each([
    ["a note cannot be proposed", ["cap_2", "note", "proposed", null, "{}", 2, null, "s", 1]],
    ["a decision cannot be live", ["cap_3", "decision", "live", null, "{}", 2, null, "s", 1]],
    ["revoked must have no payload", ["cap_4", "note", "revoked", null, "{}", 2, null, "s", 1]],
    ["a live row must keep its payload", ["cap_5", "note", "live", null, null, 2, null, "s", 1]],
    ["an unknown kind is refused", ["cap_6", "action", "proposed", null, "{}", 2, null, "s", 1]],
  ])("CHECK: %s", (_name, row) => {
    const db = migrated();
    expect(() => db.run(INSERT, row as (string | number | null)[])).toThrow(
      /CHECK constraint failed/,
    );
    db.close();
  });
});
