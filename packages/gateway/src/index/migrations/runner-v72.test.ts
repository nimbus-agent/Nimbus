import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../item-store.ts";
import { PERSON_HANDLE_COLUMNS } from "../item-write-path-v72-sql.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 72);
  return db;
}

function plan(db: Database, sql: string): string {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail)
    .join(" | ");
}

function upsert(db: Database, title: string, body: string, syncedAt = 1): void {
  upsertIndexedItem(db, {
    service: "notion",
    type: "page",
    externalId: "p1",
    title,
    body,
    modifiedAt: 10,
    syncedAt,
  });
}

function ftsHits(db: Database, term: string): number {
  return (
    db.query("SELECT COUNT(*) AS c FROM item_fts WHERE item_fts MATCH ?").get(term) as { c: number }
  ).c;
}

describe("V72 migration — item write path", () => {
  test("CURRENT_SCHEMA_VERSION is at least 72", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
  });

  test("composite item indexes replace the single-column service/type ones", () => {
    const db = migrated();
    const names = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'item'")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_item_service_type_modified");
    expect(names).toContain("idx_item_type_modified");
    expect(names).toContain("idx_item_author_modified");
    expect(names).toContain("idx_item_modified_at");
    expect(names).not.toContain("idx_item_service");
    expect(names).not.toContain("idx_item_type");
    db.close();
  });

  test("the hot filters use the new indexes", () => {
    const db = migrated();
    expect(
      plan(
        db,
        "SELECT id FROM item WHERE service IN ('github','gitlab') AND type = 'pr' AND modified_at BETWEEN 1 AND 2",
      ),
    ).toContain("idx_item_service_type_modified");
    expect(plan(db, "SELECT COUNT(*) FROM item WHERE author_id = 'p'")).toContain(
      "idx_item_author_modified",
    );
    for (const col of PERSON_HANDLE_COLUMNS) {
      expect(plan(db, `SELECT * FROM person WHERE ${col} = 'x'`)).toContain(`idx_person_${col}`);
    }
    db.close();
  });

  test("an upsert that changes no indexed text leaves item_fts consistent", () => {
    const db = migrated();
    upsert(db, "Roadmap", "alpha bravo");
    upsert(db, "Roadmap", "alpha bravo", 2); // only synced_at moves: the trigger is skipped
    expect(ftsHits(db, "bravo")).toBe(1);
    db.run("INSERT INTO item_fts(item_fts) VALUES ('integrity-check')");
    db.close();
  });

  test("a changed body or title is re-indexed and the old text is gone", () => {
    const db = migrated();
    upsert(db, "Roadmap", "alpha bravo");
    upsert(db, "Roadmap", "alpha charlie", 2);
    expect(ftsHits(db, "charlie")).toBe(1);
    expect(ftsHits(db, "bravo")).toBe(0);
    upsert(db, "Plan", "alpha charlie", 3);
    expect(ftsHits(db, "plan")).toBe(1);
    expect(ftsHits(db, "roadmap")).toBe(0);
    db.run("INSERT INTO item_fts(item_fts) VALUES ('integrity-check')");
    db.close();
  });

  test("an install upgraded from V71 gets the same trigger and indexes as a fresh one", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 71);
    upsert(db, "Old", "kept text");
    runIndexedSchemaMigrations(db, 72);
    const fresh = migrated();
    const schemaOf = (d: Database): unknown =>
      d
        .query(
          "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('item','person') AND type IN ('index','trigger') ORDER BY name",
        )
        .all();
    expect(schemaOf(db)).toEqual(schemaOf(fresh));
    expect(ftsHits(db, "kept")).toBe(1);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 72 });
    db.close();
    fresh.close();
  });
});
