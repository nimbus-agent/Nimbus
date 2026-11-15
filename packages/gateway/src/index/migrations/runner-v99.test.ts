import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CaptureStore } from "../../mcp-sink/capture-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type Column = { name: string; type: string; notnull: number; dflt_value: string | null };

function columns(db: Database): Column[] {
  return db.query("PRAGMA table_info(capture)").all() as Column[];
}

const ID = `cap_${"0f".repeat(16)}`;

/** A proposed action written with the columns a V98 database has. */
function insertAtV98(db: Database): void {
  db.run(
    `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at, expires_at, legacy)
     VALUES (?, 'action', 'proposed', NULL, '{}', 2, 'some-agent', 'conn-1', 5, 9, 0)`,
    [ID],
  );
}

describe("V99 migration - capture.label_source (Phase 28 AD7a)", () => {
  test("a fresh database has the column, TEXT NOT NULL DEFAULT 'declared', and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(columns(db).find((c) => c.name === "label_source")).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'declared'",
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(99);
    } finally {
      db.close();
    }
  });

  test("a V98 database with a queued proposal upgrades, and that proposal's label reads as declared", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 98);
      expect(columns(db).map((c) => c.name)).not.toContain("label_source");
      insertAtV98(db);
      runIndexedSchemaMigrations(db, 99);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
      const row = new CaptureStore(db).get(ID);
      expect(row?.clientLabel).toBe("some-agent");
      expect(row?.labelSource).toBe("declared");
    } finally {
      db.close();
    }
  });

  test("only the two sources can be stored", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 99);
      insertAtV98(db);
      db.run("UPDATE capture SET label_source = 'kit' WHERE id = ?", [ID]);
      expect(new CaptureStore(db).get(ID)?.labelSource).toBe("kit");
      expect(() =>
        db.run("UPDATE capture SET label_source = 'verified' WHERE id = ?", [ID]),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  test("the step can run again after user_version is rewound (the column probe)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 99);
      insertAtV98(db);
      db.run("UPDATE capture SET label_source = 'kit' WHERE id = ?", [ID]);
      db.run("PRAGMA user_version = 98");
      runIndexedSchemaMigrations(db, 99);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
      expect(new CaptureStore(db).get(ID)?.labelSource).toBe("kit");
    } finally {
      db.close();
    }
  });
});
