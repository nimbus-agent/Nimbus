import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function addTerm(db: Database, key: string): void {
  db.run(
    `INSERT INTO glossary_term (term_key, display_term, status, form, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, 'pending', 'acronym', 1, 1, 1)`,
    [key, key.toUpperCase()],
  );
}

describe("V75 migration — glossary_term.definition_local", () => {
  test("CURRENT_SCHEMA_VERSION is at least 75", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(75);
  });

  test("an existing row gets definition_local = 0", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 74);
      addTerm(db, "cdr");
      runIndexedSchemaMigrations(db, 75);
      expect(db.query("SELECT definition_local FROM glossary_term").get()).toEqual({
        definition_local: 0,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 75 });
    } finally {
      db.close();
    }
  });

  test("a new row defaults to 0 and the CHECK rejects anything but 0 or 1", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 75);
      addTerm(db, "wal");
      expect(db.query("SELECT definition_local FROM glossary_term").get()).toEqual({
        definition_local: 0,
      });
      db.run("UPDATE glossary_term SET definition_local = 1 WHERE term_key = 'wal'");
      expect(() =>
        db.run("UPDATE glossary_term SET definition_local = 2 WHERE term_key = 'wal'"),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
