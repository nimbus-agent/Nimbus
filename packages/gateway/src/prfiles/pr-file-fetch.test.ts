import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import type { SyncContext } from "../sync/types.ts";
import type { ChangedFileRow } from "./pr-changed-file-store.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";
import {
  applyFileCap,
  MAX_FILES_PER_PR,
  MAX_PAGES_PER_PR,
  runPrFilePass,
  selectPrFileCandidates,
} from "./pr-file-fetch.ts";

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

/** Only the two fields the driver touches; cast keeps the fake honest about that. */
function fakeCtx(db: Database, acquired: string[]): SyncContext {
  return {
    db,
    logger: { warn: () => undefined, info: () => undefined } as unknown as SyncContext["logger"],
    rateLimiter: {
      acquire: async (s: string) => {
        acquired.push(s);
      },
    } as unknown as SyncContext["rateLimiter"],
  } as unknown as SyncContext;
}

describe("runPrFilePass", () => {
  test("writes files and a coverage row for each candidate", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => ({ rows: [row("src/a.ts")], hasMore: false }),
    });
    expect(n).toBe(1);
    const s = db.query("SELECT stored_count FROM pr_files_state").get() as { stored_count: number };
    expect(s.stored_count).toBe(1);
    db.close();
  });

  // Per-candidate isolation. p1 throwing must not cost p2 its coverage row, and
  // must not roll back anything already written this tick.
  test("one candidate failing does not stop or roll back the others", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 200);
    addPr(db, "p2", "o/r#2", 100);
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (c) => {
        if (c.itemId === "p1") throw new Error("boom");
        return { rows: [row("src/b.ts")], hasMore: false };
      },
    });
    expect(n).toBe(1);
    const ids = (
      db.query("SELECT item_id FROM pr_files_state").all() as Array<{ item_id: string }>
    ).map((r) => r.item_id);
    expect(ids).toEqual(["p2"]);
    db.close();
  });

  // A failed candidate must NOT get a coverage row: an empty row would assert
  // "we checked this PR and it touched nothing" - a confident wrong negative.
  test("a failed candidate is left uncovered, not recorded as empty", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        throw new Error("boom");
      },
    });
    const c = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(c.c).toBe(0);
    db.close();
  });

  test("a null page result leaves the PR uncovered too", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => null,
    });
    const c = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(c.c).toBe(0);
    db.close();
  });

  test("accumulates rows across pages until hasMore is false", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (_c, page) => ({
        rows: [row(`p${String(page)}.ts`)],
        hasMore: page < 2,
      }),
    });
    const paths = (
      db.query("SELECT path FROM pr_changed_file ORDER BY path").all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(paths).toEqual(["p1.ts", "p2.ts"]);
    db.close();
  });

  test("stops at MAX_PAGES_PER_PR and marks the PR truncated", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (_c, page) => ({ rows: [row(`p${String(page)}.ts`)], hasMore: true }),
    });
    const s = db.query("SELECT stored_count, truncated FROM pr_files_state").get() as {
      stored_count: number;
      truncated: number;
    };
    expect(s.stored_count).toBe(MAX_PAGES_PER_PR);
    expect(s.truncated).toBe(1);
    db.close();
  });

  test("acquires the rate limiter once per request", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const acquired: string[] = [];
    await runPrFilePass(fakeCtx(db, acquired), {
      service: "github",
      nowMs: 5,
      // Distinct paths per page: a real PR listing never repeats a path across pages, and a
      // repeated path here would collide on `pr_changed_file`'s `(item_id, path)` primary key —
      // unrelated to what this test actually checks (the rate limiter is acquired once per page).
      fetchPage: async (_c, page) => ({ rows: [row(`a${String(page)}.ts`)], hasMore: page < 2 }),
    });
    expect(acquired).toEqual(["github", "github"]);
    db.close();
  });
});
