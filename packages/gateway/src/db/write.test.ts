import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DiskFullError, dbExec, dbRun, dbStmtRun } from "./write.ts";

describe("dbRun", () => {
  test("returns Bun's RunResult shape on a normal INSERT", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
    const result = dbRun(db, "INSERT INTO t (n) VALUES (?)", [42]);
    expect(result).toBeDefined();
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);
    db.close();
  });

  test("returns RunResult for parameterless statements", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO t DEFAULT VALUES");
    const result = dbRun(db, "DELETE FROM t");
    expect(result.changes).toBe(1);
    db.close();
  });

  test("returns RunResult with changes=0 on UPDATE that matches no rows", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
    const result = dbRun(db, "UPDATE t SET n = 99 WHERE id = ?", [999]);
    expect(result.changes).toBe(0);
    db.close();
  });

  test("propagates non-SQLITE_FULL errors verbatim", () => {
    const db = new Database(":memory:");
    let caught: unknown;
    try {
      dbRun(db, "INSERT INTO does_not_exist (x) VALUES (?)", [1]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DiskFullError);
    expect((caught as Error).message).toMatch(/no such table/i);
    db.close();
  });
});

describe("dbExec", () => {
  test("executes multi-statement SQL", () => {
    const db = new Database(":memory:");
    dbExec(db, "CREATE TABLE t (id INTEGER); INSERT INTO t (id) VALUES (1);");
    const row = db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(row.c).toBe(1);
    db.close();
  });
});

describe("DiskFullError translation", () => {
  test("dbRun translates SQLITE_FULL into DiskFullError", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n BLOB)");
    db.exec("PRAGMA max_page_count = 4");
    let caught: unknown;
    try {
      const big = new Uint8Array(64 * 1024);
      for (let i = 0; i < 100; i++) dbRun(db, "INSERT INTO t (n) VALUES (?)", [big]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiskFullError);
    db.close();
  });

  test("dbExec translates SQLITE_FULL into DiskFullError", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n BLOB)");
    db.exec("PRAGMA max_page_count = 4");
    let caught: unknown;
    try {
      const big = "x".repeat(64 * 1024);
      for (let i = 0; i < 100; i++) dbExec(db, `INSERT INTO t (n) VALUES ('${big}')`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiskFullError);
    db.close();
  });
});

describe("dbStmtRun", () => {
  test("returns Bun's Statement RunResult shape on a normal INSERT", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
    const stmt = db.prepare("INSERT INTO t (n) VALUES (?)");
    const result = dbStmtRun(stmt, 42);
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);
    stmt.finalize();
    db.close();
  });

  test("forwards multiple positional bind values (BigInt, Float32Array)", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (rowid INTEGER PRIMARY KEY, blob BLOB)");
    const stmt = db.prepare("INSERT INTO t (rowid, blob) VALUES (?, ?)");
    const result = dbStmtRun(stmt, BigInt(7), new Float32Array([1, 2, 3]));
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(7);
    stmt.finalize();
    db.close();
  });

  test("translates SQLITE_FULL into DiskFullError", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n BLOB)");
    db.exec("PRAGMA max_page_count = 4");
    const stmt = db.prepare("INSERT INTO t (n) VALUES (?)");
    let caught: unknown;
    try {
      const big = new Uint8Array(64 * 1024);
      for (let i = 0; i < 100; i++) dbStmtRun(stmt, big);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiskFullError);
    stmt.finalize();
    db.close();
  });
});
