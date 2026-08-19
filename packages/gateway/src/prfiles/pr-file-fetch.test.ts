import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import type { ChangedFileRow } from "./pr-changed-file-store.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";
import { applyFileCap, MAX_FILES_PER_PR, selectPrFileCandidates } from "./pr-file-fetch.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL, type TEXT NOT NULL,
    external_id TEXT NOT NULL, modified_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  return db;
}

function addPr(db: Database, id: string, extId: string, modified: number): void {
  db.exec(`INSERT INTO item VALUES ('${id}','github','pr','${extId}', ${String(modified)})`);
}

const row = (path: string): ChangedFileRow => ({ path, status: "modified", counterpartPath: null });

describe("selectPrFileCandidates", () => {
  test("returns PRs with no coverage row, newest first", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    addPr(db, "p2", "o/r#2", 300);
    addPr(db, "p3", "o/r#3", 200);
    const got = selectPrFileCandidates(db, "github", 10).map((c) => c.itemId);
    expect(got).toEqual(["p2", "p3", "p1"]);
    db.close();
  });

  test("a PR that already has coverage is not re-queued", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [row("a.ts")],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrFileCandidates(db, "github", 10)).toEqual([]);
    db.close();
  });

  test("respects the limit", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    addPr(db, "p2", "o/r#2", 200);
    expect(selectPrFileCandidates(db, "github", 1)).toHaveLength(1);
    db.close();
  });

  test("does not return items of another service or another type", () => {
    const db = makeDb();
    db.exec(`INSERT INTO item VALUES ('g1','gitlab','pr','a/b!1', 100)`);
    db.exec(`INSERT INTO item VALUES ('i1','github','issue','o/r#9', 100)`);
    expect(selectPrFileCandidates(db, "github", 10)).toEqual([]);
    db.close();
  });

  test("derives repoFull from the external id", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#42", 100);
    expect(selectPrFileCandidates(db, "github", 10)[0]?.repoFull).toBe("o/r");
    db.close();
  });
});

describe("applyFileCap", () => {
  test("under the cap keeps everything and is not truncated", () => {
    const r = applyFileCap([row("a.ts"), row("b.ts")]);
    expect(r.kept).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  test("exactly at the cap is NOT truncated", () => {
    const files = Array.from({ length: MAX_FILES_PER_PR }, (_, i) => row(`f${String(i)}.ts`));
    const r = applyFileCap(files);
    expect(r.kept).toHaveLength(MAX_FILES_PER_PR);
    expect(r.truncated).toBe(false);
  });

  test("over the cap truncates and flags it", () => {
    const files = Array.from({ length: MAX_FILES_PER_PR + 1 }, (_, i) => row(`f${String(i)}.ts`));
    const r = applyFileCap(files);
    expect(r.kept).toHaveLength(MAX_FILES_PER_PR);
    expect(r.truncated).toBe(true);
  });
});
