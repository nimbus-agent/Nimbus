import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import type { VerifyFinding, VerifyResult } from "./verify.ts";
import { formatVerifyResult, verifyIndex } from "./verify.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed by a test */
  }
});

describe("verifyIndex — skipped-branch coverage", () => {
  test("fts5_consistency reports skipped when item_fts is absent", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const fts = result.findings.find((f) => f.label === "fts5_consistency");
    expect(fts?.status).toBe("ok");
    expect(fts?.detail).toContain("not present, skipped");
    fresh.close();
  });

  test("vec_rowid_mismatch reports skipped when vec tables are absent", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    expect(vec?.status).toBe("ok");
    expect(vec?.detail).toContain("not present, skipped");
    fresh.close();
  });

  test("orphaned_sync_tokens reports skipped when sync_state is absent", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const orph = result.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(orph?.status).toBe("ok");
    expect(orph?.detail).toContain("not present, skipped");
    fresh.close();
  });
});

describe("verifyIndex — schema_version branches", () => {
  test("fresh DB without _schema_migrations + expected=0 reports ok", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("ok");
    fresh.close();
  });

  test("missing _schema_migrations + expected>0 reports fail", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 7);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("_schema_migrations table missing");
    fresh.close();
  });

  test("applied/user_version mismatch reports detailed gap", () => {
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION + 5);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("expected=");
    expect(sv?.detail).toContain("applied=");
  });
});

describe("verifyIndex — vec_rowid_mismatch true-mismatch path", () => {
  test("more embedding_chunk rows than vec rows produces FAIL with negative diff", () => {
    const hasVec = db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_items_384'`)
      .get();
    if (hasVec === null) {
      return;
    }

    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('vec:1', 'vec', 'note', '1', 'x', 1, 1)`,
    );
    db.run(
      `INSERT INTO embedding_chunk
       (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('vec:1', 0, 'hello', 9999999, 'test', 384, 1)`,
    );

    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    expect(vec?.status).toBe("fail");
    expect(vec?.detail).toMatch(/vec rows.*embedding_chunk rows/);
  });
});

describe("verifyIndex — foreign_key_integrity violation path", () => {
  test("orphan child row in a child→parent FK is reported", () => {
    db.run("PRAGMA foreign_keys = OFF");
    db.run(`CREATE TABLE IF NOT EXISTS _fkparent (id TEXT PRIMARY KEY)`);
    db.run(`
      CREATE TABLE IF NOT EXISTS _fkchild (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES _fkparent(id)
      )
    `);
    db.run(`INSERT INTO _fkchild (id, parent_id) VALUES ('c1', 'ghost')`);

    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const fk = result.findings.find((f) => f.label === "foreign_key_integrity");
    expect(fk?.status).toBe("fail");
    expect(fk?.detail).toContain("violation");
    expect(fk?.detail).toContain("_fkchild");
  });
});

describe("verifyIndex — catch-block coverage via broken queries", () => {
  test("orphaned_sync_tokens catch block fires when sync_state is altered to omit connector_id", () => {
    const fresh = new Database(":memory:");
    LocalIndex.ensureSchema(fresh);
    fresh.run("DROP TABLE sync_state");
    fresh.run("CREATE TABLE sync_state (other_col TEXT PRIMARY KEY)");
    const result = verifyIndex(fresh, LocalIndex.SCHEMA_VERSION);
    const orph = result.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(orph?.status).toBe("fail");
    expect(orph?.detail).toBeDefined();
    fresh.close();
  });

  test("fts5_consistency catch block fires when the FTS5 command targets a non-fts5 table", () => {
    const fresh = new Database(":memory:");
    LocalIndex.ensureSchema(fresh);
    fresh.run("DROP TABLE IF EXISTS item_fts");
    fresh.run("CREATE TABLE item_fts (other TEXT)");
    const result = verifyIndex(fresh, LocalIndex.SCHEMA_VERSION);
    const fts = result.findings.find((f) => f.label === "fts5_consistency");
    expect(fts?.status).toBe("fail");
    expect(fts?.detail).toBeDefined();
    fresh.close();
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal fake Database object for catch/defensive branches.
// Only the methods that verify.ts actually calls are stubbed; everything else
// delegates to a real in-memory SQLite so unrelated checks stay valid.
// ---------------------------------------------------------------------------

/** Minimal shape of a bun:sqlite Statement returned by db.query() */
type FakeStmt = {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
};

/** Partial shape of bun:sqlite Database that verify.ts touches */
type FakeDb = {
  query: (sql: string) => FakeStmt;
  run: (sql: string) => void;
};

/** Delegate a real bun:sqlite statement, forwarding variadic params. */
function delegateStmt(real: Database, sql: string): FakeStmt {
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

/**
 * Build a fake Database that delegates all calls to a real backing DB except
 * for the one SQL fragment listed in `interceptSql`. For that fragment:
 *   - if `throwOnQuery` is set, `.all()` / `.get()` on the returned statement throws it
 *   - if `returnNullOnGet` is true, `.get()` returns null (for defensive ?? arms)
 *   - if `throwOnRun` is set, `db.run()` throws it (for dbRun-routed writes)
 */
function makeFakeDb(
  real: Database,
  opts: {
    interceptSql?: string;
    throwOnQuery?: unknown;
    returnNullOnGet?: boolean;
    throwOnRun?: unknown;
  } = {},
): Database {
  const fake: FakeDb = {
    query(sql: string): FakeStmt {
      const { interceptSql, throwOnQuery, returnNullOnGet } = opts;
      const shouldIntercept = interceptSql !== undefined && sql.includes(interceptSql);
      if (shouldIntercept && throwOnQuery !== undefined) {
        const thrown = throwOnQuery;
        return {
          all() {
            throw thrown;
          },
          get() {
            throw thrown;
          },
        };
      }
      if (shouldIntercept && returnNullOnGet === true) {
        return {
          all(...args: unknown[]) {
            return delegateStmt(real, sql).all(...args);
          },
          get() {
            return null;
          },
        };
      }
      return delegateStmt(real, sql);
    },
    run(sql: string): void {
      if (opts.throwOnRun !== undefined) {
        throw opts.throwOnRun;
      }
      real.run(sql);
    },
  };
  return fake as unknown as Database;
}

// ---------------------------------------------------------------------------
// Line 22 FALSE arm: integrity_check returns non-"ok" row
// ---------------------------------------------------------------------------
describe("verifyIndex — integrity_check FAIL path", () => {
  test("integrity_check returns non-ok detail lines → FAIL finding", () => {
    // Use a real DB that has the full schema so other checks don't interfere,
    // but override PRAGMA integrity_check to return a corruption row.
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        if (sql.includes("integrity_check")) {
          return {
            all() {
              return [
                { integrity_check: "*** in database main ***" },
                { integrity_check: "row 5 missing from index item_fts" },
              ] as unknown[];
            },
            get() {
              return { integrity_check: "*** in database main ***" };
            },
          };
        }
        return delegateStmt(real, sql);
      },
      run(sql: string): void {
        real.run(sql);
      },
    };

    const result = verifyIndex(fake as unknown as Database, LocalIndex.SCHEMA_VERSION);
    const ic = result.findings.find((f) => f.label === "integrity_check");
    expect(ic?.status).toBe("fail");
    expect(ic?.detail).toContain("row 5 missing");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 35 TRUE + FALSE: checkIntegrity catch — Error and non-Error throws
// ---------------------------------------------------------------------------
describe("verifyIndex — integrity_check catch branches", () => {
  test("integrity_check catch TRUE arm: thrown Error → detail is err.message", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);
    const thrownErr = new Error("integrity query exploded");
    const fakeDb = makeFakeDb(real, {
      interceptSql: "integrity_check",
      throwOnQuery: thrownErr,
    });
    const result = verifyIndex(fakeDb, LocalIndex.SCHEMA_VERSION);
    const ic = result.findings.find((f) => f.label === "integrity_check");
    expect(ic?.status).toBe("fail");
    expect(ic?.detail).toBe("integrity query exploded");
    real.close();
  });

  test("integrity_check catch FALSE arm: thrown non-Error → detail is String(thrown)", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);
    const nonError: unknown = "integrity_check_boom_string";
    const fakeDb = makeFakeDb(real, {
      interceptSql: "integrity_check",
      throwOnQuery: nonError,
    });
    const result = verifyIndex(fakeDb, LocalIndex.SCHEMA_VERSION);
    const ic = result.findings.find((f) => f.label === "integrity_check");
    expect(ic?.status).toBe("fail");
    expect(ic?.detail).toBe("integrity_check_boom_string");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Line 59 FALSE: checkFts5Consistency catch — non-Error throw from dbRun
// (The TRUE arm / Error throw is already covered by the real-table test above;
// this adds the non-Error arm.)
// ---------------------------------------------------------------------------
describe("verifyIndex — fts5_consistency catch non-Error arm", () => {
  test("fts5 catch FALSE arm: db.run throws non-Error → detail is String(thrown)", () => {
    // We need item_fts to EXIST (so the check doesn't skip) but db.run to throw
    // a non-Error when the INSERT is attempted.
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    const nonError: unknown = 42;

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        return delegateStmt(real, sql);
      },
      run(_sql: string): void {
        throw nonError;
      },
    };

    const result = verifyIndex(fake as unknown as Database, LocalIndex.SCHEMA_VERSION);
    const fts = result.findings.find((f) => f.label === "fts5_consistency");
    expect(fts?.status).toBe("fail");
    expect(fts?.detail).toBe("42");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 81 + 82: vecRow?.c ?? 0 and chunkRow?.c ?? 0 defensive ?? arms
// (both tables exist but .get() returns null/undefined — extremely defensive)
// ---------------------------------------------------------------------------
describe("verifyIndex — vec count defensive null arms", () => {
  test("vecRow null → vecCount defaults to 0, chunkRow null → chunkCount defaults to 0 → ok", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    // Ensure both tables exist in the real DB (skip if vec extension absent)
    const hasVec =
      real
        .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_items_384'`)
        .get() !== null;
    const hasChunk =
      real
        .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_chunk'`)
        .get() !== null;

    if (!hasVec || !hasChunk) {
      real.close();
      return; // vec extension not loaded — skip gracefully
    }

    // Build a fake that returns null for both COUNT queries
    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        if (sql.includes("COUNT(*)") && sql.includes("vec_items_384")) {
          return {
            all() {
              return [];
            },
            get() {
              return null;
            },
          };
        }
        if (sql.includes("COUNT(*)") && sql.includes("embedding_chunk")) {
          return {
            all() {
              return [];
            },
            get() {
              return null;
            },
          };
        }
        return delegateStmt(real, sql);
      },
      run(sql: string): void {
        real.run(sql);
      },
    };

    const result = verifyIndex(fake as unknown as Database, LocalIndex.SCHEMA_VERSION);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    // Both default to 0 → counts equal → ok
    expect(vec?.status).toBe("ok");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 99 TRUE + FALSE: checkVecRowidAlignment catch — Error and non-Error
// ---------------------------------------------------------------------------
describe("verifyIndex — vec catch branches", () => {
  test("vec catch TRUE arm: thrown Error → detail is err.message", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    const hasVec =
      real
        .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_items_384'`)
        .get() !== null;
    const hasChunk =
      real
        .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_chunk'`)
        .get() !== null;

    if (!hasVec || !hasChunk) {
      real.close();
      return;
    }

    const thrownErr = new Error("vec count exploded");
    const fakeDb = makeFakeDb(real, {
      interceptSql: "COUNT(*)",
      throwOnQuery: thrownErr,
    });

    const result = verifyIndex(fakeDb, LocalIndex.SCHEMA_VERSION);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    expect(vec?.status).toBe("fail");
    expect(vec?.detail).toBe("vec count exploded");
    real.close();
  });

  test("vec catch FALSE arm: thrown non-Error → detail is String(thrown)", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    const hasVec =
      real
        .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_items_384'`)
        .get() !== null;
    const hasChunk =
      real
        .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_chunk'`)
        .get() !== null;

    if (!hasVec || !hasChunk) {
      real.close();
      return;
    }

    const nonError: unknown = "vec_count_boom";
    const fakeDb = makeFakeDb(real, {
      interceptSql: "COUNT(*)",
      throwOnQuery: nonError,
    });

    const result = verifyIndex(fakeDb, LocalIndex.SCHEMA_VERSION);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    expect(vec?.status).toBe("fail");
    expect(vec?.detail).toBe("vec_count_boom");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Line 133: row?.v ?? 0 right arm — MAX(version) over empty _schema_migrations
// returns a row with v: null, so applied defaults to 0.
// ---------------------------------------------------------------------------
describe("verifyIndex — schema_version null MAX(version) arm", () => {
  test("empty _schema_migrations → MAX(version) null → applied=0; expected=0 → ok", () => {
    const fresh = new Database(":memory:");
    // Create _schema_migrations without any rows so MAX(version) returns null
    fresh.run(
      "CREATE TABLE _schema_migrations (version INTEGER NOT NULL, applied_at TEXT NOT NULL)",
    );
    // PRAGMA user_version defaults to 0; expected=0 → both match → ok
    const result = verifyIndex(fresh, 0);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("ok");
    fresh.close();
  });

  test("empty _schema_migrations → applied=0; expected=5 → fail with applied=0", () => {
    const fresh = new Database(":memory:");
    fresh.run(
      "CREATE TABLE _schema_migrations (version INTEGER NOT NULL, applied_at TEXT NOT NULL)",
    );
    const result = verifyIndex(fresh, 5);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("applied=0");
    fresh.close();
  });
});

// ---------------------------------------------------------------------------
// Line 144: uvRow?.user_version ?? 0 right arm — fake db returns null for
// PRAGMA user_version so uv defaults to 0.
// ---------------------------------------------------------------------------
describe("verifyIndex — schema_version uvRow null arm", () => {
  test("uvRow null for PRAGMA user_version → uv defaults to 0", () => {
    const real = new Database(":memory:");
    // Create _schema_migrations with a version=5 row so applied=5 but uv→null→0
    real.run(
      "CREATE TABLE _schema_migrations (version INTEGER NOT NULL, applied_at TEXT NOT NULL)",
    );
    real.run("INSERT INTO _schema_migrations (version, applied_at) VALUES (5, '2024-01-01')");

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        if (sql.includes("user_version")) {
          return {
            all() {
              return [];
            },
            get() {
              return null; // triggers ?? 0 at line 147
            },
          };
        }
        return delegateStmt(real, sql);
      },
      run(sql: string): void {
        real.run(sql);
      },
    };

    const result = verifyIndex(fake as unknown as Database, 5);
    const sv = result.findings.find((f) => f.label === "schema_version");
    // applied=5 === expected=5 but uv=0 !== expected=5 → FAIL
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("user_version=0");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Line 147 FALSE right operand: applied === expectedVersion but uv !== expectedVersion
// Real & reachable: _schema_migrations has version=N but PRAGMA user_version = 0.
// ---------------------------------------------------------------------------
describe("verifyIndex — schema_version applied-ok but uv-mismatch", () => {
  test("applied=N matches expected but user_version=0 → FAIL detail has user_version=0", () => {
    const fresh = new Database(":memory:");
    fresh.run(
      "CREATE TABLE _schema_migrations (version INTEGER NOT NULL, applied_at TEXT NOT NULL)",
    );
    // Insert version=5 as applied (applied_at IS NOT NULL)
    fresh.run("INSERT INTO _schema_migrations (version, applied_at) VALUES (5, '2024-01-01')");
    // PRAGMA user_version stays at 0 (default) — we do NOT set it to 5

    const result = verifyIndex(fresh, 5);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    // applied=5 but uv=0 ≠ 5
    expect(sv?.detail).toContain("user_version=0");
    expect(sv?.detail).toContain("applied=5");
    fresh.close();
  });
});

// ---------------------------------------------------------------------------
// Line 159: checkSchemaVersion outer catch — uvRow?.user_version ?? 0 right arm.
// Triggered when _schema_migrations is absent (the catch fires) AND a fake db
// returns null for PRAGMA user_version so the ?? 0 arm executes.
// ---------------------------------------------------------------------------
describe("verifyIndex — schema_version outer catch uvRow null arm", () => {
  test("_schema_migrations missing AND uvRow null → uv defaults to 0 → expected=0 → ok", () => {
    // No _schema_migrations table → query throws → catch fires.
    // Inside catch, PRAGMA user_version returns null → ?? 0 → uv=0; expected=0 → ok.
    const real = new Database(":memory:");
    // real has no _schema_migrations — query will throw

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        if (sql.includes("user_version")) {
          return {
            all() {
              return [];
            },
            get() {
              return null; // triggers ?? 0 at line 159
            },
          };
        }
        return delegateStmt(real, sql);
      },
      run(sql: string): void {
        real.run(sql);
      },
    };

    const result = verifyIndex(fake as unknown as Database, 0);
    const sv = result.findings.find((f) => f.label === "schema_version");
    // uv=0 and expected=0 → ok
    expect(sv?.status).toBe("ok");
    real.close();
  });

  test("_schema_migrations missing AND uvRow null → uv defaults to 0 → expected=3 → fail", () => {
    const real = new Database(":memory:");

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        if (sql.includes("user_version")) {
          return {
            all() {
              return [];
            },
            get() {
              return null;
            },
          };
        }
        return delegateStmt(real, sql);
      },
      run(sql: string): void {
        real.run(sql);
      },
    };

    const result = verifyIndex(fake as unknown as Database, 3);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("_schema_migrations table missing");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 196 TRUE + FALSE: checkForeignKeyIntegrity catch — Error and non-Error.
// db.run throws inside dbRun → dbRun rethrows → verify's catch fires.
// ---------------------------------------------------------------------------
describe("verifyIndex — fk catch branches", () => {
  test("fk catch TRUE arm: db.run throws Error → detail is err.message", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    const thrownErr = new Error("fk pragma exploded");

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        return delegateStmt(real, sql);
      },
      run(_sql: string): void {
        throw thrownErr;
      },
    };

    const result = verifyIndex(fake as unknown as Database, LocalIndex.SCHEMA_VERSION);
    const fk = result.findings.find((f) => f.label === "foreign_key_integrity");
    expect(fk?.status).toBe("fail");
    expect(fk?.detail).toBe("fk pragma exploded");
    real.close();
  });

  test("fk catch FALSE arm: db.run throws non-Error → detail is String(thrown)", () => {
    const real = new Database(":memory:");
    LocalIndex.ensureSchema(real);

    const nonError: unknown = "fk_boom_string";

    const fake: FakeDb = {
      query(sql: string): FakeStmt {
        return delegateStmt(real, sql);
      },
      run(_sql: string): void {
        throw nonError;
      },
    };

    const result = verifyIndex(fake as unknown as Database, LocalIndex.SCHEMA_VERSION);
    const fk = result.findings.find((f) => f.label === "foreign_key_integrity");
    expect(fk?.status).toBe("fail");
    expect(fk?.detail).toBe("fk_boom_string");
    real.close();
  });
});

// ---------------------------------------------------------------------------
// formatVerifyResult: [ok]/[FAIL] tags, detail undefined vs defined, exitCode
// ---------------------------------------------------------------------------
describe("formatVerifyResult", () => {
  // verify.ts: tag = f.status === "ok" ? "[ok]  " : "[FAIL]", then ` ${f.label}`.
  // So ok lines are "[ok]   <label>" (3 spaces) and fail lines are "[FAIL] <label>" (1 space).

  test("clean result → all [ok] lines, exitCode 0", () => {
    const result: VerifyResult = {
      findings: [
        { label: "integrity_check", status: "ok" },
        { label: "fts5_consistency", status: "ok", detail: "item_fts not present, skipped" },
      ],
      clean: true,
    };
    const { output, exitCode } = formatVerifyResult(result);
    expect(exitCode).toBe(0);
    expect(output).toContain("[ok]   integrity_check");
    expect(output).toContain("[ok]   fts5_consistency: item_fts not present, skipped");
  });

  test("result with a failure → [FAIL] line, exitCode 1", () => {
    const result: VerifyResult = {
      findings: [
        { label: "integrity_check", status: "ok" },
        {
          label: "schema_version",
          status: "fail",
          detail: "applied=0, user_version=0, expected=5",
        },
      ],
      clean: false,
    };
    const { output, exitCode } = formatVerifyResult(result);
    expect(exitCode).toBe(1);
    expect(output).toContain("[ok]   integrity_check");
    expect(output).toContain("[FAIL] schema_version: applied=0");
  });

  test("finding with undefined detail → no colon appended", () => {
    const finding: VerifyFinding = { label: "vec_rowid_mismatch", status: "ok" };
    const result: VerifyResult = { findings: [finding], clean: true };
    const { output } = formatVerifyResult(result);
    // tag "[ok]  " + " " + label = "[ok]   vec_rowid_mismatch", no trailing colon
    expect(output).toBe("[ok]   vec_rowid_mismatch");
  });

  test("finding with defined detail → colon+detail appended", () => {
    const finding: VerifyFinding = {
      label: "fts5_consistency",
      status: "ok",
      detail: "skipped",
    };
    const result: VerifyResult = { findings: [finding], clean: true };
    const { output } = formatVerifyResult(result);
    expect(output).toBe("[ok]   fts5_consistency: skipped");
  });
});
