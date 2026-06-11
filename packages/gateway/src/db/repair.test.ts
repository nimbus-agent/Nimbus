/**
 * Branch-coverage tests for db/repair.ts (true-coverage program B4).
 *
 * Uses real in-memory SQLite + a minimal hand-rolled schema that satisfies
 * every SQL query in repair.ts, without loading the full migration stack
 * (which would pull in sqlite-vec). Where the full LocalIndex schema is
 * needed to drive verifyIndex we import it; elsewhere we build tables inline.
 *
 * D-candidates (intentionally unreachable branches — see bottom of file).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatRepairReport, repairIndex } from "./repair.ts";

// ---------------------------------------------------------------------------
// Minimal schema helpers
// ---------------------------------------------------------------------------

/**
 * Creates the minimal set of tables needed by verifyIndex (called from
 * repairIndex) and by the repair functions themselves, WITHOUT loading
 * sqlite-vec. vec_items_384 is created as a plain table so COUNT/DELETE work.
 */
function buildMinimalDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    -- Required by checkIntegrity (always first check in verifyIndex)
    -- Nothing special needed — PRAGMA integrity_check works on any db.

    -- _schema_migrations — required by checkSchemaVersion
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );

    -- sync_state — required by checkOrphanedSyncTokens + repairOrphanedSyncTokens
    CREATE TABLE IF NOT EXISTS sync_state (
      connector_id    TEXT PRIMARY KEY,
      last_sync_at    INTEGER,
      next_sync_token TEXT
    );

    -- scheduler_state — required by checkOrphanedSyncTokens + repairVecOrphans cursor reset
    CREATE TABLE IF NOT EXISTS scheduler_state (
      service_id              TEXT PRIMARY KEY,
      cursor                  TEXT,
      interval_ms             INTEGER NOT NULL DEFAULT 60000,
      last_sync_at            INTEGER,
      next_sync_at            INTEGER,
      status                  TEXT    NOT NULL DEFAULT 'ok',
      error_msg               TEXT,
      consecutive_failures    INTEGER NOT NULL DEFAULT 0,
      paused                  INTEGER NOT NULL DEFAULT 0
    );

    -- audit_log — written by writeAuditEntry after repairs
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      hitl_status TEXT NOT NULL,
      action_json TEXT NOT NULL,
      timestamp   INTEGER NOT NULL
    );

    -- item_fts as a NON-fts5 table so the integrity-check INSERT throws
    -- (used by the fts5_consistency fail path; recreated per-test as needed)

    -- vec_items_384 as a PLAIN table (no sqlite-vec extension required)
    CREATE TABLE IF NOT EXISTS vec_items_384 (
      rowid INTEGER PRIMARY KEY
    );

    -- embedding_chunk — required by checkVecRowidAlignment
    CREATE TABLE IF NOT EXISTS embedding_chunk (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text  TEXT NOT NULL,
      vec_rowid   INTEGER,
      model       TEXT,
      dims        INTEGER,
      embedded_at INTEGER
    );
  `);
  return db;
}

/**
 * Stamp the _schema_migrations table so checkSchemaVersion is satisfied
 * at the given version number.
 */
function stampVersion(db: Database, version: number): void {
  db.run(
    `INSERT OR REPLACE INTO _schema_migrations (version, description, applied_at) VALUES (?, 'test', 1)`,
    [version],
  );
  db.exec(`PRAGMA user_version = ${String(version)}`);
}

// ---------------------------------------------------------------------------
// Suite 1 — clean index: no failures → outcomes: [], "clean" return
// ---------------------------------------------------------------------------

describe("repairIndex — clean index (no repairs needed)", () => {
  let db: Database;

  beforeEach(() => {
    db = buildMinimalDb();
    stampVersion(db, 0);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  test("returns empty outcomes array and a repairedAt timestamp", () => {
    const before = Date.now();
    const report = repairIndex(db, 0);
    const after = Date.now();

    expect(report.outcomes).toEqual([]);
    expect(typeof report.repairedAt).toBe("string");
    const ts = new Date(report.repairedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  test("formatRepairReport on empty outcomes returns clean message", () => {
    const report = repairIndex(db, 0);
    const msg = formatRepairReport(report);
    expect(msg).toBe("Nothing to repair — index is clean.");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — vec_rowid_mismatch → repairVecOrphans
// ---------------------------------------------------------------------------

describe("repairIndex — vec_rowid_mismatch triggers repairVecOrphans", () => {
  let db: Database;

  beforeEach(() => {
    db = buildMinimalDb();
    stampVersion(db, 0);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  test("orphaned vec rows are deleted and scheduler cursor is reset", () => {
    // Insert vec rows (orphans — no corresponding embedding_chunk)
    db.run(`INSERT INTO vec_items_384 (rowid) VALUES (1)`);
    db.run(`INSERT INTO vec_items_384 (rowid) VALUES (2)`);

    // Add a scheduler row with a non-null cursor so we can verify it is reset
    db.run(
      `INSERT INTO scheduler_state (service_id, cursor, interval_ms, status) VALUES ('svc-a', 'tok123', 60000, 'ok')`,
    );

    // Precondition: embedding_chunk has 0 rows, vec_items_384 has 2 → mismatch
    const vecCountBefore = (
      db.query("SELECT COUNT(*) as c FROM vec_items_384").get() as { c: number }
    ).c;
    expect(vecCountBefore).toBe(2);

    const report = repairIndex(db, 0);

    expect(report.outcomes).toHaveLength(1);
    const outcome = report.outcomes[0];
    expect(outcome?.action).toBe("vec_orphan_delete");
    expect(outcome?.status).toBe("applied");
    expect(outcome?.detail).toContain("2 orphaned vec row(s)");
    expect(outcome?.detail).toContain("reset all sync cursors");

    // Vec rows must be gone
    const vecCountAfter = (
      db.query("SELECT COUNT(*) as c FROM vec_items_384").get() as { c: number }
    ).c;
    expect(vecCountAfter).toBe(0);

    // Cursor must be reset to NULL
    const row = db.query("SELECT cursor FROM scheduler_state WHERE service_id = 'svc-a'").get() as {
      cursor: string | null;
    };
    expect(row?.cursor).toBeNull();
  });

  test("vec orphan repair returns applied with 1 deleted row (single orphan)", () => {
    db.run(`INSERT INTO vec_items_384 (rowid) VALUES (99)`);

    const report = repairIndex(db, 0);
    expect(report.outcomes[0]?.status).toBe("applied");
    expect(report.outcomes[0]?.detail).toContain("1 orphaned vec row(s)");
  });

  test("when all vec rows match embedding_chunk — no mismatch — repairVecOrphans skipped path (line 32)", () => {
    // Insert matching pair: vec rowid 5, embedding_chunk.vec_rowid 5
    db.run(`INSERT INTO vec_items_384 (rowid) VALUES (5)`);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('item-x', 0, 'hello', 5, 'm', 384, 1)`,
    );
    // Both counts are 1 — verifyIndex reports ok, so repairVecOrphans never runs
    const report = repairIndex(db, 0);
    const vecOutcome = report.outcomes.find((o) => o.action === "vec_orphan_delete");
    expect(vecOutcome).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — orphaned_sync_tokens → repairOrphanedSyncTokens
// ---------------------------------------------------------------------------

describe("repairIndex — orphaned_sync_tokens triggers repairOrphanedSyncTokens", () => {
  let db: Database;

  beforeEach(() => {
    db = buildMinimalDb();
    stampVersion(db, 0);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  test("orphaned sync_state rows are deleted and outcome is applied", () => {
    // Insert a sync_state row whose connector_id has no matching scheduler_state row
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('orphan-connector', 1, 'tok')`,
    );
    // scheduler_state is empty → connector_id not in scheduler → verify FAILS

    const before = (db.query("SELECT COUNT(*) as c FROM sync_state").get() as { c: number }).c;
    expect(before).toBe(1);

    const report = repairIndex(db, 0);

    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome?.status).toBe("applied");
    expect(outcome?.detail).toContain("1 orphaned token row(s)");

    const after = (db.query("SELECT COUNT(*) as c FROM sync_state").get() as { c: number }).c;
    expect(after).toBe(0);
  });

  test("multiple orphaned tokens are all deleted", () => {
    db.run(`INSERT INTO sync_state (connector_id) VALUES ('ghost-1')`);
    db.run(`INSERT INTO sync_state (connector_id) VALUES ('ghost-2')`);

    const report = repairIndex(db, 0);
    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome?.status).toBe("applied");
    expect(outcome?.detail).toContain("2 orphaned token row(s)");
  });

  test("non-orphaned token (connector_id in scheduler_state) is NOT deleted", () => {
    // Register the service in scheduler_state first
    db.run(
      `INSERT INTO scheduler_state (service_id, interval_ms, status) VALUES ('registered-svc', 60000, 'ok')`,
    );
    // Add a sync_state row pointing to the registered service — not orphaned
    db.run(`INSERT INTO sync_state (connector_id) VALUES ('registered-svc')`);

    const report = repairIndex(db, 0);
    // No orphan check should fail — repair should not run
    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome).toBeUndefined();
    // Row must still exist
    const row = db.query("SELECT COUNT(*) as c FROM sync_state").get() as { c: number };
    expect(row.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — foreign_key_integrity → repairForeignKeys (the I9 path)
// ---------------------------------------------------------------------------

describe("repairIndex — foreign_key_integrity triggers repairForeignKeys (I9 escapeIdentifier)", () => {
  let db: Database;

  beforeEach(() => {
    db = buildMinimalDb();
    stampVersion(db, 0);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  test("FK-violating child row is deleted; escapeIdentifier path exercised with real table name", () => {
    // Create parent + child tables with a FK relationship
    db.exec(`
      CREATE TABLE _fk_parent (id TEXT PRIMARY KEY);
      CREATE TABLE _fk_child (
        id        TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES _fk_parent(id)
      );
    `);

    // Insert orphan child row with FK enforcement OFF (simulate broken state)
    db.run("PRAGMA foreign_keys = OFF");
    db.run(`INSERT INTO _fk_child (id, parent_id) VALUES ('c1', 'nonexistent')`);
    db.run("PRAGMA foreign_keys = ON");

    const childCountBefore = (
      db.query("SELECT COUNT(*) as c FROM _fk_child").get() as { c: number }
    ).c;
    expect(childCountBefore).toBe(1);

    const report = repairIndex(db, 0);

    const outcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(outcome?.status).toBe("applied");
    expect(outcome?.detail).toContain("1 row(s) with FK violations");

    // The offending row must be gone
    const childCountAfter = (db.query("SELECT COUNT(*) as c FROM _fk_child").get() as { c: number })
      .c;
    expect(childCountAfter).toBe(0);
  });

  test("multiple FK violations across one table are all deleted in batch", () => {
    db.exec(`
      CREATE TABLE _fk_parent2 (id TEXT PRIMARY KEY);
      CREATE TABLE _fk_child2 (
        id        TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES _fk_parent2(id)
      );
    `);

    db.run("PRAGMA foreign_keys = OFF");
    db.run(`INSERT INTO _fk_child2 (id, parent_id) VALUES ('a', 'ghost1')`);
    db.run(`INSERT INTO _fk_child2 (id, parent_id) VALUES ('b', 'ghost2')`);
    db.run("PRAGMA foreign_keys = ON");

    const report = repairIndex(db, 0);
    const outcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(outcome?.status).toBe("applied");
    expect(outcome?.detail).toContain("2 row(s) with FK violations");

    const remaining = (db.query("SELECT COUNT(*) as c FROM _fk_child2").get() as { c: number }).c;
    expect(remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — catch arms (lines 62/76/102/165 true-Error branch)
// Trigger by making verify report a FAIL, then dropping the table the repair
// needs so the repair SQL throws.
// ---------------------------------------------------------------------------

describe("repairIndex — catch arms produce error outcomes", () => {
  let db: Database;

  beforeEach(() => {
    db = buildMinimalDb();
    stampVersion(db, 0);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  test("repairVecOrphans catch arm — vec_items_384 is WITHOUT ROWID so rowid SELECT throws (line 62)", () => {
    // WITHOUT ROWID tables have no implicit rowid column.
    // verifyIndex's checkVecRowidAlignment does COUNT(*) (works fine) →
    // reports mismatch when counts differ.
    // repairVecOrphans then does SELECT v.rowid ... which throws on a WITHOUT
    // ROWID table → catch arm fires.
    db.run("DROP TABLE vec_items_384");
    db.exec(`
      CREATE TABLE vec_items_384 (
        vec_id INTEGER NOT NULL,
        PRIMARY KEY (vec_id)
      ) WITHOUT ROWID
    `);
    // Insert a row (COUNT=1) with embedding_chunk empty (COUNT=0) → mismatch
    db.run("INSERT INTO vec_items_384 (vec_id) VALUES (1)");

    const report = repairIndex(db, 0);
    const outcome = report.outcomes.find((o) => o.action === "vec_orphan_delete");
    expect(outcome?.status).toBe("error");
    expect(typeof outcome?.detail).toBe("string");
    expect((outcome?.detail ?? "").length).toBeGreaterThan(0);
  });

  test("repairFts5 catch arm — item_fts is a plain table so special INSERT throws (line 76)", () => {
    // verifyIndex's checkFts5Consistency checks tableExists then does
    //   INSERT INTO item_fts(item_fts) VALUES('integrity-check')
    // which throws on a non-fts5 table → fts5_consistency = fail.
    // repairFts5 then does
    //   INSERT INTO item_fts(item_fts) VALUES('rebuild')
    // which also throws on the same plain table → catch arm fires.
    // Keep item_fts as a plain table for BOTH verify and repair calls.
    db.exec("CREATE TABLE item_fts (other TEXT)");

    const report = repairIndex(db, 0);
    const outcome = report.outcomes.find((o) => o.action === "fts5_rebuild");
    expect(outcome?.status).toBe("error");
    expect(typeof outcome?.detail).toBe("string");
    expect((outcome?.detail ?? "").length).toBeGreaterThan(0);
  });

  test("repairOrphanedSyncTokens catch arm — sync_state lacks connector_id column (line 102)", () => {
    // Replace sync_state with a table lacking the connector_id column.
    // verifyIndex's checkOrphanedSyncTokens queries connector_id → throws →
    // orphaned_sync_tokens = fail.
    // repairOrphanedSyncTokens then DELETEs WHERE connector_id NOT IN ... →
    // also throws (no such column) → catch arm fires.
    db.run("DROP TABLE sync_state");
    db.exec("CREATE TABLE sync_state (bad_col TEXT PRIMARY KEY)");

    const report = repairIndex(db, 0);
    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome?.status).toBe("error");
    expect(typeof outcome?.detail).toBe("string");
    expect((outcome?.detail ?? "").length).toBeGreaterThan(0);
  });

  test("repairForeignKeys catch arm — DELETE blocked by BEFORE trigger that raises (line 165)", () => {
    // Create parent + child tables with a FK, insert an orphan child (FK off),
    // then add a BEFORE DELETE trigger that raises an error so the repair
    // DELETE throws inside the transaction → catch arm fires.
    db.exec(`
      CREATE TABLE _fk_pb (id TEXT PRIMARY KEY);
      CREATE TABLE _fk_cb (
        id        TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES _fk_pb(id)
      );
    `);
    db.run("PRAGMA foreign_keys = OFF");
    db.run(`INSERT INTO _fk_cb (id, parent_id) VALUES ('x', 'ghost')`);
    db.run("PRAGMA foreign_keys = ON");

    // Add a trigger that unconditionally raises so repair's DELETE throws
    db.exec(`
      CREATE TRIGGER _fk_cb_block_delete
      BEFORE DELETE ON _fk_cb
      BEGIN
        SELECT RAISE(ABORT, 'delete blocked by test trigger');
      END
    `);

    const report = repairIndex(db, 0);
    const outcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(outcome?.status).toBe("error");
    expect(typeof outcome?.detail).toBe("string");
    expect((outcome?.detail ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — formatRepairReport: all status tags + detail lines
// ---------------------------------------------------------------------------

describe("formatRepairReport", () => {
  test("returns clean message for empty outcomes", () => {
    const msg = formatRepairReport({ outcomes: [], repairedAt: "2026-06-11T00:00:00.000Z" });
    expect(msg).toBe("Nothing to repair — index is clean.");
  });

  test("applied tag is rendered", () => {
    const msg = formatRepairReport({
      outcomes: [
        {
          action: "vec_orphan_delete",
          status: "applied",
          detail: "deleted 3 orphaned vec row(s); reset all sync cursors",
        },
      ],
      repairedAt: "2026-06-11T00:00:00.000Z",
    });
    expect(msg).toContain("[applied]");
    expect(msg).toContain("vec_orphan_delete");
    expect(msg).toContain("deleted 3");
    expect(msg).toContain("Repaired at: 2026-06-11T00:00:00.000Z");
  });

  test("skipped tag is rendered", () => {
    const msg = formatRepairReport({
      outcomes: [
        { action: "vec_orphan_delete", status: "skipped", detail: "no orphaned vec rows" },
      ],
      repairedAt: "2026-06-11T00:00:00.000Z",
    });
    expect(msg).toContain("[skipped]");
  });

  test("error tag is rendered", () => {
    const msg = formatRepairReport({
      outcomes: [{ action: "fts5_rebuild", status: "error", detail: "no such table: item_fts" }],
      repairedAt: "2026-06-11T00:00:00.000Z",
    });
    expect(msg).toContain("[ error ]");
    expect(msg).toContain("fts5_rebuild");
    expect(msg).toContain("no such table");
  });

  test("mixed outcomes render all three tags", () => {
    const msg = formatRepairReport({
      outcomes: [
        { action: "fts5_rebuild", status: "applied", detail: "item_fts rebuilt" },
        { action: "vec_orphan_delete", status: "skipped", detail: "no orphaned vec rows" },
        { action: "orphaned_sync_tokens_delete", status: "error", detail: "boom" },
      ],
      repairedAt: "2026-06-11T12:00:00.000Z",
    });
    expect(msg).toContain("[applied]");
    expect(msg).toContain("[skipped]");
    expect(msg).toContain("[ error ]");
    expect(msg).toContain("Repaired at: 2026-06-11T12:00:00.000Z");
  });

  test("outcome with no detail omits the colon-suffix", () => {
    const msg = formatRepairReport({
      outcomes: [{ action: "fts5_rebuild", status: "applied" }],
      repairedAt: "2026-06-11T00:00:00.000Z",
    });
    // Should not contain a stray ": " at end of action name
    expect(msg).not.toContain("fts5_rebuild:");
    expect(msg).toContain("fts5_rebuild");
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — audit_log entry is written after a repair
// ---------------------------------------------------------------------------

describe("repairIndex — audit_log entry written", () => {
  test("audit_log receives a db.repair entry after repairs run", () => {
    const db = buildMinimalDb();
    stampVersion(db, 0);

    // Create an orphaned sync token to force at least one repair
    db.run(`INSERT INTO sync_state (connector_id) VALUES ('audit-test-ghost')`);

    const before = (db.query("SELECT COUNT(*) as c FROM audit_log").get() as { c: number }).c;

    repairIndex(db, 0);

    const after = (db.query("SELECT COUNT(*) as c FROM audit_log").get() as { c: number }).c;
    expect(after).toBe(before + 1);

    const row = db.query("SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1").get() as {
      action_type: string;
    };
    expect(row?.action_type).toBe("db.repair");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — catch false-arms (lines 76 / 102): err instanceof Error FALSE branch
// Trigger by making verify produce a FAIL, then using a selective delegating
// proxy whose .run() throws a NON-Error only for the targeted SQL fragment,
// delegating all other .run() calls to a real backing db.
// ---------------------------------------------------------------------------

/** Minimal shape of a bun:sqlite Statement returned by db.query() */
type FakeStmt = {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
};

/** Partial shape of bun:sqlite Database that repair.ts touches */
type FakeRepairDb = {
  query: (sql: string) => FakeStmt;
  run: (sql: string, ...rest: unknown[]) => void;
  transaction: (fn: () => void) => () => void;
};

/** Delegate a real bun:sqlite statement, forwarding variadic params. */
function delegateRepairStmt(real: Database, sql: string): FakeStmt {
  return {
    all(...args: unknown[]) {
      const stmt = real.query(sql);
      return (
        args.length > 0 ? stmt.all(...(args as Parameters<typeof stmt.all>)) : stmt.all()
      ) as unknown[];
    },
    get(...args: unknown[]) {
      const stmt = real.query(sql);
      return (
        args.length > 0 ? stmt.get(...(args as Parameters<typeof stmt.get>)) : stmt.get()
      ) as unknown;
    },
  };
}

describe("repairIndex — catch false-arm: non-Error thrown from db.run", () => {
  test("repairFts5 false-arm (line 76): non-Error detail === String(thrown)", () => {
    // Real backing db: item_fts exists (as a plain table) so tableExists returns
    // true and checkFts5Consistency proceeds to the INSERT.  All other tables are
    // present so the remaining verify checks don't blow up.
    const real = buildMinimalDb();
    stampVersion(real, 0);
    real.exec("CREATE TABLE item_fts (other TEXT)");

    const nonError: unknown = "fts5 rebuild blew up";

    const fake: FakeRepairDb = {
      query(sql: string): FakeStmt {
        return delegateRepairStmt(real, sql);
      },
      run(sql: string, ...rest: unknown[]): void {
        // Intercept only the item_fts INSERT (both verify's integrity-check and
        // repair's rebuild).  All other .run() calls (PRAGMA foreign_keys, audit_log
        // INSERT, etc.) are delegated to the real backing db — forwarding bound
        // params so writeAuditEntry's parameterised INSERT actually executes.
        if (sql.includes("item_fts")) {
          throw nonError;
        }
        const realRun = real.run.bind(real) as unknown as (s: string, ...r: unknown[]) => void;
        realRun(sql, ...rest);
      },
      transaction(fn: () => void): () => void {
        return real.transaction(fn);
      },
    };

    const report = repairIndex(fake as unknown as Database, 0);
    const outcome = report.outcomes.find((o) => o.action === "fts5_rebuild");
    expect(outcome?.status).toBe("error");
    // String(nonError) === "fts5 rebuild blew up" — proves the FALSE arm executed
    expect(outcome?.detail).toBe(String(nonError));

    real.close();
  });

  test("repairOrphanedSyncTokens false-arm (line 102): non-Error detail === String(thrown)", () => {
    // Real backing db: sync_state has an orphaned row (connector_id not in
    // scheduler_state) so checkOrphanedSyncTokens returns fail.
    const real = buildMinimalDb();
    stampVersion(real, 0);
    real.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('orphan-ghost', 1, 'tok')`,
    );
    // scheduler_state is empty → connector_id not found → verify FAILS

    const nonError: unknown = "sync delete blew up";

    const fake: FakeRepairDb = {
      query(sql: string): FakeStmt {
        return delegateRepairStmt(real, sql);
      },
      run(sql: string, ...rest: unknown[]): void {
        // Intercept only the DELETE FROM sync_state write.  All other .run() calls
        // (PRAGMA foreign_keys = ON from checkForeignKeyIntegrity, audit_log
        // INSERT from writeAuditEntry, etc.) are delegated to the real db —
        // forwarding bound params so the parameterised audit INSERT executes.
        if (sql.includes("DELETE FROM sync_state")) {
          throw nonError;
        }
        const realRun = real.run.bind(real) as unknown as (s: string, ...r: unknown[]) => void;
        realRun(sql, ...rest);
      },
      transaction(fn: () => void): () => void {
        return real.transaction(fn);
      },
    };

    const report = repairIndex(fake as unknown as Database, 0);
    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome?.status).toBe("error");
    // String(nonError) === "sync delete blew up" — proves the FALSE arm executed
    expect(outcome?.detail).toBe(String(nonError));

    real.close();
  });
});

// ---------------------------------------------------------------------------
// D-candidates (NOT tested — intentionally unreachable or race-only branches)
// ---------------------------------------------------------------------------
//
// line 32 (repairVecOrphans):
//   `if (orphans.length === 0) return skipped`
//   This branch is ONLY reachable if verifyIndex said vec_rowid_mismatch=FAIL
//   (meaning vec count ≠ chunk count) but the subsequent SELECT for orphaned
//   vec rows returns 0. That requires vec rows to disappear between the two
//   SQL queries — a pure race / TOCTOU. D-candidate: not fabricated.
//
// line 89 (repairOrphanedSyncTokens):
//   `(result as {changes}).changes ?? 0` — RIGHT arm (`?? 0`)
//   `dbRun` always returns a SQLite statement result which always has a
//   `.changes` field (never undefined). The `?? 0` is a defensive fallback
//   added for robustness. D-candidate: defensive-only.
//
// line 90 (repairOrphanedSyncTokens):
//   `if (deleted === 0) return skipped`
//   Repair only runs when verify said orphaned_sync_tokens=FAIL (there are
//   orphans), so the DELETE must remove ≥1 row. deleted===0 can only occur
//   if the orphan is cleaned up between verify and repair — a race.
//   D-candidate: race-only.
//
// line 123 (repairForeignKeys):
//   `if (violations.length === 0) return skipped`
//   Same race pattern: repair only runs when verify said foreign_key_integrity
//   =FAIL, so PRAGMA foreign_key_check must have returned violations. They
//   could only be gone between verify and repair due to a concurrent write.
//   D-candidate: race-only.
//
// line 139 (repairForeignKeys — I9 guard):
//   `if (isUnsafeSqlIdentifier(table)) continue`
//   PRAGMA foreign_key_check returns table names from SQLite's own catalog —
//   these are always valid SQL identifiers (non-empty, no NUL). This guard is
//   an intentional I9 DEFENSE-IN-DEPTH against any future code path that might
//   construct a synthetic violation. It MUST NOT be removed or weakened.
//   D-candidate: unreachable via real SQLite; do not fabricate a fake FK-check.
//
// line 151 (repairForeignKeys):
//   `(res as {changes}).changes ?? 0` — RIGHT arm (`?? 0`)
//   Same pattern as line 89: dbRun's return value always carries `.changes`.
//   D-candidate: defensive-only.
//
// lines 76 / 102 — `err instanceof Error` FALSE arm:
//   Covered by Suite 8 via a selective delegating proxy that throws a non-Error
//   string only for the targeted SQL fragment.
//
// lines 62 / 165 — `err instanceof Error` FALSE arm:
//   SQLite (bun:sqlite) always throws real Error instances; a non-Error throw
//   from the driver is not observable in practice. Covered by Suite 5 tests
//   for the TRUE arm (normal Error). The FALSE arm (`String(err)`) would require
//   a non-Error value thrown by a db.query() call inside a transaction, which is
//   not interceptable without mock.module (prohibited). D-candidate for the
//   false arm only.
