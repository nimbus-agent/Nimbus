import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

function migrated(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

test("V47 creates decision_record, decision_evidence and decision_pass_state", () => {
  const db = migrated();
  const names = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('decision_record','decision_evidence','decision_pass_state')
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  expect(names.map((r) => r.name)).toEqual([
    "decision_evidence",
    "decision_pass_state",
    "decision_record",
  ]);
  db.close();
});

test("V47 decision_record rejects an unknown status", () => {
  const db = migrated();
  expect(() =>
    db.run(
      `INSERT INTO decision_record
         (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
       VALUES ('d1','i1','bogus','weak','we decided',1,1)`,
    ),
  ).toThrow();
  db.close();
});

test("V47 decision_record rejects an unknown cue_tier", () => {
  const db = migrated();
  expect(() =>
    db.run(
      `INSERT INTO decision_record
         (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
       VALUES ('d1','i1','pending','shouty','we decided',1,1)`,
    ),
  ).toThrow();
  db.close();
});

test("V47 decision_evidence cascades when its decision is deleted", () => {
  const db = migrated();
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    `INSERT INTO decision_record
       (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
     VALUES ('d1','i1','extracted','heading','Decision:',1,1)`,
  );
  db.run(
    `INSERT INTO decision_evidence (decision_id, kind, label)
     VALUES ('d1','pr','#412')`,
  );
  db.run("DELETE FROM decision_record WHERE id = 'd1'");
  const left = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
  expect(left.n).toBe(0);
  db.close();
});

test("V47 decision_pass_state is single-row", () => {
  const db = migrated();
  db.run("INSERT INTO decision_pass_state (id) VALUES (1)");
  expect(() => db.run("INSERT INTO decision_pass_state (id) VALUES (2)")).toThrow();
  db.close();
});

test("V47 is idempotent across a second migration run", () => {
  const db = migrated();
  expect(() => runMigrations(db)).not.toThrow();
  db.close();
});
