import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CAPTURE_REBUILD_V97_SQL } from "../agent-door-v97-sql.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import {
  maxRegisteredIndexedSchemaVersion,
  rebuildCaptureForV97,
  runIndexedSchemaMigrations,
} from "./runner.ts";

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  try {
    return stmt.all() as Array<Record<string, unknown>>;
  } finally {
    stmt.finalize();
  }
}

function captureColumns(db: Database): string[] {
  return rows(db, "PRAGMA table_info(capture)").map((c) => String(c["name"]));
}

/** Every kind and state V69 admits, written as the OLD schema allowed. */
function seedV96(db: Database): void {
  db.run(
    `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, native_ref, created_at, decided_at, expires_at, outcome_ref, error_code)
     VALUES
     ('n1','note','live','nimbus:n1','{"t":1}',7,'cl','s1',NULL,10,NULL,NULL,NULL,NULL),
     ('d1','decision','accepted','nimbus:d1','{"s":1}',7,NULL,'s2','capture:d1',20,21,NULL,NULL,NULL),
     ('t1','term','revoked',NULL,NULL,0,NULL,'s3','wal',30,31,NULL,NULL,NULL),
     ('l1','link','rejected',NULL,'{"r":1}',7,NULL,'s4',NULL,40,41,NULL,NULL,NULL),
     ('a1','action','proposed',NULL,'{"a":1}',7,'lab','s5',NULL,50,NULL,500,NULL,NULL),
     ('a2','action','executed',NULL,'{"a":2}',7,NULL,'s5',NULL,51,52,500,'https://x',NULL),
     ('a3','action','failed',NULL,'{"a":3}',7,NULL,'s5',NULL,53,54,500,NULL,'ERR_ACTION_DISPATCH'),
     ('a4','action','rejected',NULL,'{"a":4}',7,NULL,'s5',NULL,55,56,500,NULL,NULL)`,
  );
}

function insertAction(db: Database, over: Record<string, unknown>): void {
  const r = {
    id: "cap_x",
    kind: "action",
    state: "proposed",
    legacy: 0,
    error_code: null,
    expires_at: 100,
    ...over,
  };
  db.run(
    `INSERT INTO capture (id, kind, state, payload_json, payload_bytes, session_id, created_at, expires_at, error_code, legacy)
     VALUES (?,?,?,'{}',2,'s',1,?,?,?)`,
    [r.id, r.kind, r.state, r.expires_at, r.error_code, r.legacy] as never,
  );
}

function insertDoor(db: Database, over: Record<string, unknown>): void {
  const r = {
    service: "github",
    door: "agent",
    tool_id: "t",
    approved_at: 1,
    definition_sha256: "a".repeat(64),
    suspended_at: null,
    suspended_sha256: null,
    ...over,
  };
  db.run(
    `INSERT INTO connector_write_door_approval (service, door, tool_id, approved_at, definition_sha256, suspended_at, suspended_sha256)
     VALUES (?,?,?,?,?,?,?)`,
    [
      r.service,
      r.door,
      r.tool_id,
      r.approved_at,
      r.definition_sha256,
      r.suspended_at,
      r.suspended_sha256,
    ] as never,
  );
}

describe("V97 migration - the agent door's approval list and the capture rebuild", () => {
  test("a fresh database reaches 97 with both objects", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_SCHEMA_VERSION,
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(97);
      expect(captureColumns(db)).toContain("legacy");
      expect(
        rows(db, "SELECT name FROM sqlite_master WHERE name = 'connector_write_door_approval'"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an upgrade from 96 keeps every column value, sets legacy 0, leaves the door table empty", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 96);
      seedV96(db);
      const before = rows(db, "SELECT * FROM capture ORDER BY id");
      expect(before).toHaveLength(8);
      runIndexedSchemaMigrations(db, 97);
      const after = rows(db, "SELECT * FROM capture ORDER BY id");
      expect(after).toHaveLength(8);
      expect(after.every((r) => r["legacy"] === 0)).toBe(true);
      expect(after.map(({ legacy: _l, ...rest }) => rest)).toEqual(before);
      expect(rows(db, "SELECT * FROM connector_write_door_approval")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the three capture indexes exist after the rebuild", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      const names = rows(
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
    } finally {
      db.close();
    }
  });

  test("a lossy copy aborts: the row-count check throws and the transaction leaves capture as it was", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 96);
      seedV96(db);
      const lossy = CAPTURE_REBUILD_V97_SQL.map((s) =>
        s.startsWith("INSERT INTO capture_v97") ? `${s} WHERE rowid % 2 = 0` : s,
      );
      expect(() => db.transaction(() => rebuildCaptureForV97(db, lossy))()).toThrow(
        /V97: capture rebuild copied 4 rows, expected 8/,
      );
      expect(rows(db, "SELECT id FROM capture")).toHaveLength(8);
      expect(captureColumns(db)).not.toContain("legacy");
    } finally {
      db.close();
    }
  });

  test("a rejected action accepts an error_code of 64 characters and refuses 65", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      expect(() =>
        insertAction(db, { id: "a", state: "rejected", error_code: "E".repeat(64) }),
      ).not.toThrow();
      expect(() =>
        insertAction(db, { id: "b", state: "rejected", error_code: "E".repeat(65) }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test.each([
    ["a proposed action with a code", { state: "proposed", error_code: "ERR_X" }],
    ["an executed action with a code", { state: "executed", error_code: "ERR_X" }],
    ["legacy 2", { legacy: 2 }],
    ["legacy on a note", { kind: "note", state: "live", expires_at: null, legacy: 1 }],
  ])("the CHECKs still refuse %s", (_n, over) => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      expect(() => insertAction(db, over)).toThrow();
    } finally {
      db.close();
    }
  });

  test("legacy 1 is accepted on an action", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      expect(() => insertAction(db, { legacy: 1 })).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("the door table refuses a short hash and an observed hash with no time, accepts a NULL observed hash", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      expect(() => insertDoor(db, { definition_sha256: "a".repeat(63) })).toThrow();
      expect(() =>
        insertDoor(db, { tool_id: "u", suspended_at: 5, suspended_sha256: "b".repeat(63) }),
      ).toThrow();
      expect(() => insertDoor(db, { tool_id: "v", suspended_sha256: "b".repeat(64) })).toThrow();
      expect(() => insertDoor(db, { tool_id: "w", suspended_at: 5 })).not.toThrow();
      expect(() =>
        insertDoor(db, { tool_id: "x", suspended_at: 5, suspended_sha256: "b".repeat(64) }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("running the step twice keeps a legacy 1 row (re-runnable)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      insertAction(db, { id: "keep", legacy: 1 });
      db.run("PRAGMA user_version = 96");
      runIndexedSchemaMigrations(db, 97);
      expect(rows(db, "SELECT legacy FROM capture WHERE id = 'keep'")).toEqual([{ legacy: 1 }]);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 97 });
    } finally {
      db.close();
    }
  });

  test("probe: no trigger, view or foreign key depends on the capture table (the rebuild needs recreate nothing else)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 96);
      expect(
        rows(
          db,
          `SELECT name FROM sqlite_master WHERE (type IN ('trigger','view') AND sql LIKE '%capture%')
             OR sql LIKE '%REFERENCES capture%' OR sql LIKE '%REFERENCES "capture"%'`,
        ),
      ).toEqual([]);
      expect(rows(db, "PRAGMA foreign_key_list(capture)")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
