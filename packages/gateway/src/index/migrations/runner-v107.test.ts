import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

const tables = (db: Database): string[] =>
  (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((r) => r.name);

describe("V107 long-term episodic memory (OR-S4-MEM, I61)", () => {
  test("the schema constant and the registered chain end at or past 107", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(107);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("a fresh database has both tables, with no foreign key and no trigger", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toContain("episodic_memory");
    expect(tables(db)).toContain("episodic_pending_turn");
    for (const t of ["episodic_memory", "episodic_pending_turn"]) {
      expect(db.query(`PRAGMA foreign_key_list(${t})`).all()).toEqual([]);
    }
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'episodic%'",
        )
        .all(),
    ).toEqual([]);
    db.close();
  });

  test("an upgrade from V105 keeps existing data and adds the tables; it is re-runnable", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 105);
    expect(tables(db)).not.toContain("episodic_memory");
    db.run(
      "INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at) VALUES ('s','t',0,'user',1)",
    );
    runIndexedSchemaMigrations(db, 107);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 107 });
    expect(db.query("SELECT COUNT(*) AS n FROM session_memory").get()).toEqual({ n: 1 });
    db.run("PRAGMA user_version = 105");
    runIndexedSchemaMigrations(db, 107);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 107 });
    db.close();
  });

  test("the summary length and the session id are constrained", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    expect(() =>
      db.run(
        "INSERT INTO episodic_memory (id, session_id, summary, turn_count, started_at, ended_at, created_at) VALUES ('m','s','',1,1,1,1)",
      ),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO episodic_pending_turn (session_id, owner_text, answer_text, created_at) VALUES ('','a','b',1)",
      ),
    ).toThrow();
    db.close();
  });
});
