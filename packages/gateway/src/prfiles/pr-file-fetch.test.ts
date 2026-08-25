import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EMPTY_NIMBUS_VAULT } from "../connectors/connector-sync-test-helpers.ts";
import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import { RateLimitError, type SyncContext, UnauthenticatedError } from "../sync/types.ts";
import type { ChangedFileRow } from "./pr-changed-file-store.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";
import {
  applyFileCap,
  MAX_FILES_PER_PR,
  MAX_PAGES_PER_PR,
  MAX_PRS_PER_TICK,
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

type WarnRecord = { readonly fields: Record<string, unknown>; readonly msg: string };

/** Only the two fields the driver touches; cast keeps the fake honest about that. */
function fakeCtx(db: Database, acquired: string[], warns?: WarnRecord[]): SyncContext {
  return {
    ...buildSyncCapabilities({ vault: EMPTY_NIMBUS_VAULT, db, depth: "full" }, "github"),
    logger: {
      warn: (fields: Record<string, unknown>, msg: string) => {
        warns?.push({ fields, msg });
      },
      info: () => undefined,
    } as unknown as SyncContext["logger"],
    rateLimiter: {
      tryAcquire: async (s: string) => {
        acquired.push(s);
        return true;
      },
    } as unknown as SyncContext["rateLimiter"],
  } as unknown as SyncContext;
}

/** A `tryAcquire` that always reports the provider penalised/exhausted — never grants a token. */
function fakeCtxRateLimited(db: Database): SyncContext {
  return {
    ...buildSyncCapabilities({ vault: EMPTY_NIMBUS_VAULT, db, depth: "full" }, "github"),
    logger: { warn: () => undefined, info: () => undefined } as unknown as SyncContext["logger"],
    rateLimiter: {
      tryAcquire: async () => false,
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

  // Regression: a rename chain (`a.ts -> b.ts` plus `c.ts -> a.ts`) maps to
  // ["b.ts","a.ts","a.ts","c.ts"] - a legitimate repeated path within ONE PR. Before the fix,
  // the raw insert threw on `pr_changed_file`'s (item_id, path) primary key, and because
  // `recordPrChangedFiles` was called OUTSIDE the try, that throw escaped `runPrFilePass`
  // entirely and stranded every later candidate in the same tick.
  test("a rename-chain duplicate path in one PR does not stop the tick", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 200);
    addPr(db, "p2", "o/r#2", 100);
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (c) => {
        if (c.itemId === "p1") {
          return {
            rows: [row("b.ts"), row("a.ts"), row("a.ts"), row("c.ts")],
            hasMore: false,
          };
        }
        return { rows: [row("d.ts")], hasMore: false };
      },
    });
    expect(n).toBe(2);
    const ids = (
      db.query("SELECT item_id FROM pr_files_state").all() as Array<{ item_id: string }>
    ).map((r) => r.item_id);
    expect(ids.sort()).toEqual(["p1", "p2"]);
    const p1Paths = (
      db
        .query("SELECT path FROM pr_changed_file WHERE item_id = 'p1' ORDER BY path")
        .all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(p1Paths).toEqual(["a.ts", "b.ts", "c.ts"]);
    db.close();
  });

  test("a RateLimitError from fetchPage propagates and ends the tick", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const rejection = runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        throw new RateLimitError(new Date(), "rate limited");
      },
    });
    await expect(rejection).rejects.toBeInstanceOf(RateLimitError);
    db.close();
  });

  test("an UnauthenticatedError propagates and stops attempting further candidates", async () => {
    const db = makeDb();
    // Three candidates: without the rethrow the pass swallows the 401 per-candidate and issues one
    // doomed request for EACH of them, so `attempts` is what distinguishes the fix from the bug.
    addPr(db, "p1", "o/r#1", 300);
    addPr(db, "p2", "o/r#2", 200);
    addPr(db, "p3", "o/r#3", 100);
    let attempts = 0;
    const rejection = runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        attempts += 1;
        throw new UnauthenticatedError("GitHub pull files: 401");
      },
    });
    await expect(rejection).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(attempts).toBe(1);
    // The candidate is left UNCOVERED, exactly as a failed fetch leaves it — a coverage row here
    // would assert "we know this PR's files" on the strength of a 401.
    const covered = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(covered.c).toBe(0);
    db.close();
  });

  test("a plain Error from fetchPage does NOT propagate - it is swallowed per-candidate", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        throw new Error("transient");
      },
    });
    expect(n).toBe(0);
    db.close();
  });

  // Regression: a provider under a rate-limit penalty must be detected via `tryAcquire`
  // (non-blocking) rather than `acquire` (which sleeps out the whole penalty window). Some 429
  // handlers in this codebase call `rateLimiter.penalise()` WITHOUT throwing, so the driver
  // cannot rely on an exception to learn the provider is penalised — it must poll `tryAcquire`
  // and back off itself. `fetchPage` must never be called once `tryAcquire` reports `false`.
  test("tryAcquire returning false records nothing, calls fetchPage never, and stops the tick", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 200);
    addPr(db, "p2", "o/r#2", 100);
    let fetchPageCalls = 0;
    const n = await runPrFilePass(fakeCtxRateLimited(db), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        fetchPageCalls += 1;
        return { rows: [row("never.ts")], hasMore: false };
      },
    });
    expect(n).toBe(0);
    expect(fetchPageCalls).toBe(0);
    const c = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(c.c).toBe(0);
    db.close();
  });

  // Head-of-line regression. `selectPrFileCandidates` is strictly `modified_at DESC` and a failed
  // candidate is deliberately left with no coverage row, so without an attempt budget the ten
  // newest PRs — say, all in a repo that was deleted — would refill the whole budget every tick
  // and coverage would sit at zero forever. With it, the healthy older PR is still reached.
  test("a broken head does not starve older healthy PRs in the same tick", async () => {
    const db = makeDb();
    // Newest MAX_PRS_PER_TICK all fail; one older healthy PR sits behind them.
    for (let i = 0; i < MAX_PRS_PER_TICK; i++) {
      addPr(db, `broken${String(i)}`, `o/r#${String(100 + i)}`, 1000 + i);
    }
    addPr(db, "healthy", "o/r#1", 1);

    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (c) =>
        c.itemId === "healthy" ? { rows: [row("src/a.ts")], hasMore: false } : null,
    });

    expect(n).toBe(1);
    const ids = (
      db.query("SELECT item_id FROM pr_files_state").all() as Array<{ item_id: string }>
    ).map((r) => r.item_id);
    expect(ids).toEqual(["healthy"]);
    db.close();
  });

  // The other half of the budget: the extra candidates are an ATTEMPT allowance, not a raised
  // record cap. A tick where everything succeeds must still stop at MAX_PRS_PER_TICK.
  test("a healthy tick still records at most MAX_PRS_PER_TICK and attempts no more", async () => {
    const db = makeDb();
    for (let i = 0; i < MAX_PRS_PER_TICK + 5; i++) {
      addPr(db, `p${String(i)}`, `o/r#${String(i)}`, 1000 + i);
    }
    let attempts = 0;
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        attempts += 1;
        return { rows: [row("src/a.ts")], hasMore: false };
      },
    });
    expect(n).toBe(MAX_PRS_PER_TICK);
    expect(attempts).toBe(MAX_PRS_PER_TICK);
    db.close();
  });

  // FIX 4: the null-page path is the one a 404 on a deleted/private repo takes, and it is the
  // failure that repeats forever. It must be visible in the log, naming the service and the PR.
  test("a null page result is logged with the service and item id", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const warns: WarnRecord[] = [];
    await runPrFilePass(fakeCtx(db, [], warns), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => null,
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({ service: "github", itemId: "p1" });
    db.close();
  });
});
