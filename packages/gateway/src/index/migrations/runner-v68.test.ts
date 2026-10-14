import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "./runner.ts";

/** Seed the V67 shape directly: a migration test must write what the OLD schema allowed. */
function seedV67(db: Database): void {
  db.run(
    `INSERT INTO decision_record (id, source_item_id, status, statement, extraction_source, cue_tier, cue_text, confidence, decided_at, updated_at)
     VALUES ('d1', 'slack:m1', 'extracted', 'Use WAL', 'llm', 'heading', 'Decision:', 0.9, 10, 11),
            ('d2', 'slack:m2', 'pending', NULL, NULL, 'weak', 'we will', 0, 20, 21)`,
  );
  db.run(
    `INSERT INTO decision_evidence (decision_id, kind, entity_id, item_id, evidence_key, label, url, occurred_at)
     VALUES ('d1', 'source', NULL, 'slack:m1', 'item:slack:m1', 'thread', NULL, 10),
            ('d1', 'pr', 'e-pr-1', NULL, 'entity:e-pr-1', '#1', 'https://x/1', 12)`,
  );
  db.run(
    `INSERT INTO glossary_term (term_key, display_term, status, definition, definition_source, doc_freq, first_seen_at, last_seen_at, updated_at)
     VALUES ('wal', 'WAL', 'consolidated', 'write-ahead log', 'manual', 3, 1, 2, 3)`,
  );
}

/**
 * `db.query` caches the compiled statement per SQL string, and a cached `SELECT *` keeps the column
 * set it was compiled with — so a read repeated after the rebuild would not see `capture_id`.
 */
function freshAll(db: Database, sql: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  try {
    return stmt.all() as Array<Record<string, unknown>>;
  } finally {
    stmt.finalize();
  }
}

function evidence(db: Database): unknown[] {
  return db.query("SELECT * FROM decision_evidence ORDER BY decision_id, evidence_key").all();
}

describe("V68 — capture provenance", () => {
  for (const fk of ["OFF", "ON"] as const) {
    test(`preserves every decision and evidence row with foreign_keys ${fk}`, () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 67);
      seedV67(db);
      const before = evidence(db);
      const decisionsBefore = freshAll(db, "SELECT * FROM decision_record ORDER BY id");
      db.run(`PRAGMA foreign_keys = ${fk}`);
      runIndexedSchemaMigrations(db, 68);
      expect(evidence(db)).toEqual(before);
      const after = freshAll(db, "SELECT * FROM decision_record ORDER BY id") as Array<
        Record<string, unknown>
      >;
      // Every pre-existing column is byte-identical; the only addition is capture_id = NULL.
      expect(after.map(({ capture_id: _c, ...rest }) => rest)).toEqual(decisionsBefore);
      expect(after.every((r) => r["capture_id"] === null)).toBe(true);
      db.close();
    });
  }

  test("an evidence row orphaned BEFORE V68 is dropped, not fatal", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 67);
    seedV67(db);
    db.run(
      `INSERT INTO decision_evidence (decision_id, kind, entity_id, item_id, evidence_key, label)
       VALUES ('gone', 'source', NULL, 'x:1', 'item:x:1', 'orphan')`,
    );
    runIndexedSchemaMigrations(db, 68);
    const n = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
    expect(n.n).toBe(2);
    db.close();
  });

  test("the evidence cascade still works after the rebuild", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 67);
    seedV67(db);
    runIndexedSchemaMigrations(db, 68);
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM decision_record WHERE id = 'd1'");
    expect(evidence(db)).toEqual([]);
    db.close();
  });

  test("glossary rows survive byte-identically; capture_id is NULL", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 67);
    seedV67(db);
    const before = freshAll(db, "SELECT * FROM glossary_term");
    runIndexedSchemaMigrations(db, 68);
    const after = freshAll(db, "SELECT * FROM glossary_term");
    expect(after.map(({ capture_id: _c, ...rest }) => rest)).toEqual(before);
    expect(after[0]?.["capture_id"]).toBeNull();
    db.close();
  });

  test("'agent' is admitted by both CHECKs; an unknown source still refuses", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    db.run(
      `INSERT INTO decision_record (id, source_item_id, status, extraction_source, cue_tier, cue_text, decided_at, updated_at, capture_id)
       VALUES ('a', 'nimbus:cap_1', 'extracted', 'agent', 'explicit', 'agent capture', 1, 1, 'cap_1')`,
    );
    db.run(
      `INSERT INTO glossary_term (term_key, display_term, status, definition, definition_source, first_seen_at, last_seen_at, updated_at, capture_id)
       VALUES ('k', 'K', 'consolidated', 'd', 'agent', 1, 1, 1, 'cap_2')`,
    );
    expect(() =>
      db.run(
        `INSERT INTO decision_record (id, source_item_id, status, extraction_source, cue_tier, cue_text, decided_at, updated_at)
         VALUES ('b', 's', 'extracted', 'robot', 'explicit', 'c', 1, 1)`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO glossary_term (term_key, display_term, status, definition_source, first_seen_at, last_seen_at, updated_at)
         VALUES ('z', 'Z', 'pending', 'robot', 1, 1, 1)`,
      ),
    ).toThrow();
    db.close();
  });

  test("recreates every index dropped with the rebuilt tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    const names = (tbl: string): string[] =>
      (
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%'",
          )
          .all(tbl) as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort();
    expect(names("decision_record")).toEqual([
      "idx_decision_decided_at",
      "idx_decision_pending_priority",
      "idx_decision_source_item",
      "idx_decision_status_confidence",
      "idx_decision_verified",
    ]);
    expect(names("glossary_term")).toEqual([
      "idx_glossary_term_display",
      "idx_glossary_term_pending_attempt",
      "idx_glossary_term_status_score",
      "idx_glossary_term_verified",
    ]);
    db.close();
  });

  test("seeds the five captured_* relation types and leaves no hold table", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    const rows = db
      .query(
        "SELECT name, directed FROM graph_relation_type WHERE name LIKE 'captured_%' ORDER BY name",
      )
      .all();
    expect(rows).toEqual([
      { name: "captured_caused_by", directed: 1 },
      { name: "captured_documents", directed: 1 },
      { name: "captured_fixes", directed: 1 },
      { name: "captured_relates_to", directed: 1 },
      { name: "captured_supersedes", directed: 1 },
    ]);
    const hold = db.query("SELECT name FROM sqlite_master WHERE name LIKE '%_v68%'").all();
    expect(hold).toEqual([]);
    db.close();
  });
});
