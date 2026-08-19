import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import {
  collectPrFileCoverage,
  recordPrChangedFiles,
  selectPrsNotTouching,
} from "./pr-changed-file-store.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL,
    type TEXT NOT NULL, external_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  return db;
}

function addPr(db: Database, id: string): void {
  db.exec(`INSERT INTO item VALUES ('${id}','github','pr','${id}')`);
}

describe("pr-changed-file-store", () => {
  test("records files and a coverage row in one call", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1000,
    });
    const s = db.query("SELECT stored_count, truncated FROM pr_files_state").get() as {
      stored_count: number;
      truncated: number;
    };
    expect(s.stored_count).toBe(1);
    expect(s.truncated).toBe(0);
    db.close();
  });

  test("a re-fetch REPLACES the previous file set rather than merging", () => {
    const db = makeDb();
    addPr(db, "p1");
    const base = { itemId: "p1", repoFull: "o/r", apiFileCount: 1, truncated: false, nowMs: 1 };
    recordPrChangedFiles(db, {
      ...base,
      files: [{ path: "old.ts", status: "modified", counterpartPath: null }],
    });
    recordPrChangedFiles(db, {
      ...base,
      files: [{ path: "new.ts", status: "modified", counterpartPath: null }],
    });
    const paths = (
      db.query("SELECT path FROM pr_changed_file ORDER BY path").all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(paths).toEqual(["new.ts"]);
    db.close();
  });

  // FAIL-CLOSED. p2 has no coverage row at all. It must NOT be returned as
  // "does not touch tests/", because we never checked.
  test("a PR with no coverage row is EXCLUDED, not returned", () => {
    const db = makeDb();
    addPr(db, "p1");
    addPr(db, "p2");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    const r = selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 });
    expect(r.itemIds).toEqual(["p1"]);
    expect(r.excludedNoCoverage).toBe(1);
    db.close();
  });

  test("a TRUNCATED PR is excluded on the same footing as an unfetched one", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 4000,
      truncated: true,
      nowMs: 1,
    });
    const r = selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 });
    expect(r.itemIds).toEqual([]);
    expect(r.excludedTruncated).toBe(1);
    db.close();
  });

  test("a PR that DELETED a file still counts as touching it", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "tests/gone.ts", status: "removed", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 }).itemIds).toEqual([]);
    db.close();
  });

  test("a rename out of tests/ still counts as touching tests/", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [
        { path: "src/a.ts", status: "renamed", counterpartPath: "tests/a.ts" },
        { path: "tests/a.ts", status: "renamed", counterpartPath: "src/a.ts" },
      ],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 }).itemIds).toEqual([]);
    db.close();
  });

  // GLOB, not LIKE. Under LIKE both of these would match and the PR would be
  // wrongly excluded from a `tests/` question.
  test("matching is case-sensitive — Tests/ does not answer a tests/ question", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "Tests/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 }).itemIds).toEqual(["p1"]);
    db.close();
  });

  test("an underscore in the pattern is literal, not a wildcard", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/myXfile.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    // Under LIKE, `my_file.ts` would match `myXfile.ts` and wrongly exclude p1.
    expect(selectPrsNotTouching(db, { pathGlob: "src/my_file.ts", limit: 50 }).itemIds).toEqual([
      "p1",
    ]);
    db.close();
  });

  test("coverage counts covered, total and truncated", () => {
    const db = makeDb();
    addPr(db, "p1");
    addPr(db, "p2");
    addPr(db, "p3");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    recordPrChangedFiles(db, {
      itemId: "p2",
      repoFull: "o/r",
      files: [{ path: "b.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 9000,
      truncated: true,
      nowMs: 1,
    });
    expect(collectPrFileCoverage(db)).toEqual({ covered: 2, totalPrs: 3, truncated: 1 });
    db.close();
  });

  // Regression: collectIndexMetrics calls collectPrFileCoverage unconditionally, and that
  // function is reached from callers on a timer (telemetry/flush-scheduler.ts,
  // ipc/metrics-server.ts). A database predating the V55 migration must not make this throw.
  test("returns zeros, and does not throw, when the V55 tables do not exist", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL,
      type TEXT NOT NULL, external_id TEXT NOT NULL)`);
    // Deliberately no PR_CHANGED_FILE_V55_SQL — pr_files_state / pr_changed_file don't exist.
    expect(() => collectPrFileCoverage(db)).not.toThrow();
    expect(collectPrFileCoverage(db)).toEqual({ covered: 0, totalPrs: 0, truncated: 0 });
    db.close();
  });
});
