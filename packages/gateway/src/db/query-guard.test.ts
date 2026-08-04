import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertReadOnlySelectSql, runReadOnlySelect, SqlGuardError } from "./query-guard.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      // Best-effort: a just-terminated worker may still hold the sqlite file open
      // on Windows (EBUSY); a leftover temp dir is harmless, a failed cleanup is not.
      // maxRetries: 0 / retryDelay: 0 — fail FAST rather than block the hook's timeout
      // budget; the leaked dir is the accepted trade-off (#972, #973). Do NOT turn this
      // back into a blocking retry.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
      } catch {
        /* worker still releasing the db handle — leave the temp dir for the OS to reap */
      }
    }
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-guard-"));
  tempDirs.push(dir);
  const path = join(dir, "test.db");
  const db = new Database(path);
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO t (name) VALUES ('a'), ('b'), ('c')");
  db.close();
  return path;
}

describe("query-guard PRAGMA allowlist (S5-F2)", () => {
  test("rejects PRAGMA secure_delete = ON", () => {
    expect(() => assertReadOnlySelectSql("SELECT * FROM t; PRAGMA secure_delete = ON;")).toThrow(
      SqlGuardError,
    );
  });

  test("rejects PRAGMA optimize", () => {
    expect(() => assertReadOnlySelectSql("SELECT 1; PRAGMA optimize;")).toThrow(SqlGuardError);
  });

  test("rejects PRAGMA mmap_size = 1024", () => {
    expect(() => assertReadOnlySelectSql("SELECT 1; PRAGMA mmap_size = 1024;")).toThrow(
      SqlGuardError,
    );
  });

  test("permits PRAGMA query_only when used after SELECT", () => {
    expect(() => assertReadOnlySelectSql("SELECT 1; PRAGMA query_only = 1")).not.toThrow();
  });

  test("permits PRAGMA table_info", () => {
    expect(() => assertReadOnlySelectSql("SELECT * FROM pragma_table_info('t')")).not.toThrow();
  });
});

describe("assertReadOnlySelectSql — statement validation (S5-F1)", () => {
  // line 27 TRUE arm: empty / whitespace-only SQL
  test("rejects empty string", () => {
    expect(() => assertReadOnlySelectSql("")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("")).toThrow("SQL statement is empty");
  });

  test("rejects whitespace-only string", () => {
    expect(() => assertReadOnlySelectSql("   ")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("   ")).toThrow("SQL statement is empty");
  });

  test("rejects tab-only string", () => {
    expect(() => assertReadOnlySelectSql("\t\n  ")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("\t\n  ")).toThrow("SQL statement is empty");
  });

  // line 30 FALSE arm: statement that doesn't start with SELECT or WITH
  test("rejects INSERT statement", () => {
    expect(() => assertReadOnlySelectSql("INSERT INTO t VALUES (1)")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("INSERT INTO t VALUES (1)")).toThrow(
      "Only SELECT (or WITH … SELECT) statements are allowed",
    );
  });

  test("rejects DELETE statement", () => {
    expect(() => assertReadOnlySelectSql("DELETE FROM t")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("DELETE FROM t")).toThrow(
      "Only SELECT (or WITH … SELECT) statements are allowed",
    );
  });

  test("rejects DROP statement", () => {
    expect(() => assertReadOnlySelectSql("DROP TABLE t")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("DROP TABLE t")).toThrow(
      "Only SELECT (or WITH … SELECT) statements are allowed",
    );
  });

  // line 33 TRUE arm: starts with SELECT but contains a FORBIDDEN keyword
  test("rejects SELECT followed by a DELETE keyword", () => {
    expect(() => assertReadOnlySelectSql("SELECT 1; DELETE FROM t")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("SELECT 1; DELETE FROM t")).toThrow(
      "Statement contains a forbidden keyword",
    );
  });

  test("rejects SELECT followed by a DROP keyword", () => {
    expect(() => assertReadOnlySelectSql("SELECT 1; DROP TABLE t")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySelectSql("SELECT 1; DROP TABLE t")).toThrow(
      "Statement contains a forbidden keyword",
    );
  });

  test("rejects WITH … SELECT that also contains DELETE", () => {
    expect(() => assertReadOnlySelectSql("WITH x AS (SELECT 1) DELETE FROM t")).toThrow(
      SqlGuardError,
    );
    expect(() => assertReadOnlySelectSql("WITH x AS (SELECT 1) DELETE FROM t")).toThrow(
      "Statement contains a forbidden keyword",
    );
  });

  test("rejects SELECT followed by an INSERT keyword", () => {
    expect(() => assertReadOnlySelectSql("SELECT id FROM t; INSERT INTO t VALUES (99)")).toThrow(
      SqlGuardError,
    );
    expect(() => assertReadOnlySelectSql("SELECT id FROM t; INSERT INTO t VALUES (99)")).toThrow(
      "Statement contains a forbidden keyword",
    );
  });

  // WITH … SELECT that is fully allowed (no forbidden keywords, no disallowed PRAGMA)
  test("permits WITH … SELECT (CTE)", () => {
    expect(() =>
      assertReadOnlySelectSql("WITH cte AS (SELECT id FROM t) SELECT * FROM cte"),
    ).not.toThrow();
  });

  // Disallowed PRAGMA error message check
  test("rejects disallowed PRAGMA with its name in the message", () => {
    expect(() => assertReadOnlySelectSql("SELECT 1; PRAGMA writable_schema")).toThrow(
      "Disallowed PRAGMA in statement: writable_schema",
    );
  });

  // Allowed PRAGMA set membership — both sides
  test("permits all members of ALLOWED_PRAGMA", () => {
    const allowedPragmas = [
      "query_only",
      "table_info",
      "foreign_key_list",
      "index_list",
      "index_info",
      "function_list",
      "module_list",
      "collation_list",
      "database_list",
      "compile_options",
    ];
    for (const pragma of allowedPragmas) {
      expect(() => assertReadOnlySelectSql(`SELECT 1; PRAGMA ${pragma}`)).not.toThrow();
    }
  });
});

describe("query-guard wall-clock timeout (S5-F3)", () => {
  test("aborts an unbounded recursive CTE within the configured timeout", async () => {
    const dbPath = tempDbPath();
    // Use a short timeout the timer reliably fires before the worker can either
    // materialise the unbounded CTE or OOM-crash — keeps the timeout-reject branch
    // deterministic (a long timeout races the timer against the worker crashing).
    const start = Date.now();
    await expect(
      runReadOnlySelect(
        dbPath,
        "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT * FROM x",
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow(/exceeded.*100ms/);
    expect(Date.now() - start).toBeLessThan(8000);
  });

  test("returns rows for a bounded SELECT well under the timeout", async () => {
    const dbPath = tempDbPath();
    const rows = await runReadOnlySelect(dbPath, "SELECT name FROM t ORDER BY id", {
      timeoutMs: 5000,
    });
    expect(rows).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
  });
});

describe("runReadOnlySelect — worker round-trip (S5-F4)", () => {
  // line 52: assertReadOnlySelectSql throws BEFORE spawning worker — rejects with SqlGuardError
  test("rejects guard-invalid SQL before spawning a worker", async () => {
    const dbPath = tempDbPath();
    await expect(runReadOnlySelect(dbPath, "DROP TABLE t")).rejects.toThrow(SqlGuardError);
    await expect(runReadOnlySelect(dbPath, "DROP TABLE t")).rejects.toThrow(
      "Only SELECT (or WITH … SELECT) statements are allowed",
    );
  });

  test("rejects guard-invalid empty SQL before spawning a worker", async () => {
    const dbPath = tempDbPath();
    await expect(runReadOnlySelect(dbPath, "   ")).rejects.toThrow(SqlGuardError);
    await expect(runReadOnlySelect(dbPath, "   ")).rejects.toThrow("SQL statement is empty");
  });

  // line 69 FALSE arm: guard-valid SQL that causes a sqlite error at execution time.
  // The worker receives it, sqlite throws (no such table), worker posts {ok:false, message:…},
  // the onmessage handler takes the else branch and calls reject(new Error(msg.message)).
  test("rejects when the worker returns ok:false (no such table)", async () => {
    const dbPath = tempDbPath();
    await expect(
      runReadOnlySelect(dbPath, "SELECT * FROM does_not_exist", { timeoutMs: 5000 }),
    ).rejects.toThrow(/does_not_exist|no such table/i);
  });

  test("rejects when the worker returns ok:false (column does not exist)", async () => {
    const dbPath = tempDbPath();
    await expect(
      runReadOnlySelect(dbPath, "SELECT nonexistent_col FROM t", { timeoutMs: 5000 }),
    ).rejects.toThrow(/nonexistent_col|no such column/i);
  });

  // Verify the resolve path returns an empty array when no rows match (rows ?? [] TRUE arm)
  test("returns empty array when SELECT matches no rows", async () => {
    const dbPath = tempDbPath();
    const rows = await runReadOnlySelect(dbPath, "SELECT id FROM t WHERE id = 9999", {
      timeoutMs: 5000,
    });
    expect(rows).toEqual([]);
  });

  // `options?.timeoutMs ?? DEFAULT_TIMEOUT_MS` — the DEFAULT arm. Every other
  // round-trip test above passes an explicit `timeoutMs`, and the two that omit
  // `options` reject inside assertReadOnlySelectSql before the default is ever
  // read, so omitting options on VALID sql was untested.
  test("succeeds with no options object, applying the default timeout", async () => {
    const dbPath = tempDbPath();
    const rows = await runReadOnlySelect(dbPath, "SELECT name FROM t ORDER BY id");
    expect(rows).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
  });

  test("omitting only timeoutMs within an options object also uses the default", async () => {
    const dbPath = tempDbPath();
    const rows = await runReadOnlySelect(dbPath, "SELECT id FROM t ORDER BY id", {});
    expect(rows).toHaveLength(3);
  });
});
