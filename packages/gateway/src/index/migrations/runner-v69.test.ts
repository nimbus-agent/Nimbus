import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "./runner.ts";

/** Seed V68 rows directly: a migration test writes what the OLD schema allowed. */
function seedV68(db: Database): void {
  db.run(
    `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, native_ref, created_at, decided_at)
     VALUES ('cap_1','note','live','nimbus:cap_1','{"title":"t"}',13,'cl','s1',NULL,10,NULL),
            ('cap_2','decision','accepted','nimbus:cap_2','{"statement":"s"}',17,NULL,'s2','capture:cap_2',20,21),
            ('cap_3','term','revoked',NULL,NULL,0,NULL,'s3','wal',30,31),
            ('cap_4','link','rejected',NULL,'{"relation":"fixes"}',20,NULL,'s4',NULL,40,41)`,
  );
}

function fresh(db: Database, sql: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  try {
    return stmt.all() as Array<Record<string, unknown>>;
  } finally {
    stmt.finalize();
  }
}

function insertAction(db: Database, over: Record<string, unknown>): void {
  const row = {
    id: "cap_a",
    kind: "action",
    state: "proposed",
    item_id: null,
    payload_json: "{}",
    payload_bytes: 2,
    session_id: "s",
    native_ref: null,
    created_at: 1,
    expires_at: 100,
    outcome_ref: null,
    error_code: null,
    ...over,
  };
  db.run(
    `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, session_id, native_ref, created_at, expires_at, outcome_ref, error_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.kind,
      row.state,
      row.item_id,
      row.payload_json,
      row.payload_bytes,
      row.session_id,
      row.native_ref,
      row.created_at,
      row.expires_at,
      row.outcome_ref,
      row.error_code,
    ] as never,
  );
}

describe("V69 — the act door's capture columns", () => {
  test("every V68 row survives byte-identical, new columns NULL, count asserted", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    seedV68(db);
    const before = fresh(db, "SELECT * FROM capture ORDER BY id");
    runIndexedSchemaMigrations(db, 69);
    const after = fresh(db, "SELECT * FROM capture ORDER BY id");
    expect(after).toHaveLength(before.length);
    expect(
      after.map(({ expires_at: _e, outcome_ref: _o, error_code: _c, ...rest }) => rest),
    ).toEqual(before);
    expect(after.every((r) => r["expires_at"] === null && r["outcome_ref"] === null)).toBe(true);
    db.close();
  });

  test("the three indexes are recreated", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 69);
    const names = fresh(
      db,
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='capture'",
    ).map((r) => r["name"]);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_capture_state_created",
        "idx_capture_created",
        "idx_capture_item_id",
      ]),
    );
    db.close();
  });

  test("a valid proposed action inserts", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 69);
    expect(() => insertAction(db, {})).not.toThrow();
    db.close();
  });

  test.each([
    ["an action without expires_at", { expires_at: null }],
    ["a note with expires_at", { kind: "note", state: "live", expires_at: 5 }],
    ["an action with an item", { item_id: "nimbus:x" }],
    ["an action with a native_ref", { native_ref: "x" }],
    ["an action in state accepted", { state: "accepted" }],
    ["a decision in state executed", { kind: "decision", state: "executed", expires_at: null }],
    ["outcome_ref on a non-executed action", { outcome_ref: "https://x" }],
    ["outcome_ref over 512", { state: "executed", outcome_ref: `https://${"a".repeat(510)}` }],
    ["error_code on a non-failed action", { error_code: "ERR_ACTION_DISPATCH" }],
    ["error_code over 64", { state: "failed", error_code: "E".repeat(65) }],
  ])("CHECK rejects %s", (_name, over) => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 69);
    expect(() => insertAction(db, over)).toThrow();
    db.close();
  });
});
