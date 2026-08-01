import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

function seedRow(db: Database, key: string, source: string): void {
  db.run(
    `INSERT INTO glossary_term
       (term_key, display_term, status, definition, definition_source,
        doc_freq, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, 'consolidated', 'd', ?, 3, 1, 2, 3)`,
    [key, key.toUpperCase(), source],
  );
}

test("V46 accepts definition_source='manual'", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(() => {
    seedRow(db, "cdr", "manual");
  }).not.toThrow();
  db.close();
});

test("V46 still rejects an unknown definition_source", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(() => {
    seedRow(db, "cdr", "bogus");
  }).toThrow();
  db.close();
});

test("V46 preserves pre-existing rows through the table rebuild", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 45);
  seedRow(db, "kept", "llm");
  runMigrations(db);
  const row = db
    .query("SELECT display_term, definition_source, doc_freq FROM glossary_term WHERE term_key = ?")
    .get("kept") as { display_term: string; definition_source: string; doc_freq: number } | null;
  expect(row).toEqual({ display_term: "KEPT", definition_source: "llm", doc_freq: 3 });
  db.close();
});

test("V46 recreates every index dropped with the old table", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const names = (
    db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='glossary_term'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  for (const idx of [
    "idx_glossary_term_status_score",
    "idx_glossary_term_pending_attempt",
    "idx_glossary_term_display",
    "idx_glossary_term_verified",
  ]) {
    expect(names).toContain(idx);
  }
  db.close();
});

test("the runner version-gates V46 and does not re-apply it on a second run", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  runMigrations(db);
  seedRow(db, "cdr", "manual");
  expect((db.query("SELECT COUNT(*) AS n FROM glossary_term").get() as { n: number }).n).toBe(1);
  db.close();
});
