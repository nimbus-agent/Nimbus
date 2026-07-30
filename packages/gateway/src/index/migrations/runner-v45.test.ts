import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | null;
  return row !== null;
}

test("V45 creates glossary_term and glossary_pass_state", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(tableExists(db, "glossary_term")).toBe(true);
  expect(tableExists(db, "glossary_pass_state")).toBe(true);
  db.close();
});

test("V45 glossary_term rejects an unknown status", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(() =>
    db.run(
      `INSERT INTO glossary_term (term_key, display_term, status, first_seen_at, last_seen_at, updated_at)
       VALUES ('x', 'X', 'bogus', 0, 0, 0)`,
    ),
  ).toThrow();
  db.close();
});

test("V45 glossary_pass_state is single-row", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.run("INSERT INTO glossary_pass_state (id, watermark_ms) VALUES (1, 5)");
  expect(() =>
    db.run("INSERT INTO glossary_pass_state (id, watermark_ms) VALUES (2, 5)"),
  ).toThrow();
  db.close();
});

test("V45 is idempotent across a second migration run", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  runMigrations(db);
  expect(tableExists(db, "glossary_term")).toBe(true);
  db.close();
});
