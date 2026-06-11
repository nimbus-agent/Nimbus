import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DiskFullError,
  dbExec,
  dbRun,
  dbStmtRun,
  isDiskSpaceWarning,
  onDiskFull,
  setDiskSpaceWarning,
} from "./write.ts";

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

// ---------------------------------------------------------------------------
// isDiskSpaceWarning / setDiskSpaceWarning / onDiskFull — unit tests
// ---------------------------------------------------------------------------

describe("isDiskSpaceWarning", () => {
  afterEach(() => {
    setDiskSpaceWarning(false);
  });

  test("returns false by default", () => {
    // Reset first — prior suites (real SQLite FULL tests) may have left the flag set
    setDiskSpaceWarning(false);
    expect(isDiskSpaceWarning()).toBe(false);
  });

  test("returns true after setDiskSpaceWarning(true)", () => {
    setDiskSpaceWarning(true);
    expect(isDiskSpaceWarning()).toBe(true);
  });

  test("returns false after toggling back to false", () => {
    setDiskSpaceWarning(true);
    setDiskSpaceWarning(false);
    expect(isDiskSpaceWarning()).toBe(false);
  });
});

describe("setDiskSpaceWarning — listener notification", () => {
  afterEach(() => {
    setDiskSpaceWarning(false);
  });

  test("fires registered onDiskFull listeners when transitioning false→true", () => {
    let fired = 0;
    const unsub = onDiskFull(() => {
      fired++;
    });
    setDiskSpaceWarning(true);
    expect(fired).toBe(1);
    unsub();
  });

  test("does NOT fire listeners when already true→true (no re-fire)", () => {
    setDiskSpaceWarning(true);
    let fired = 0;
    const unsub = onDiskFull(() => {
      fired++;
    });
    setDiskSpaceWarning(true);
    expect(fired).toBe(0);
    unsub();
  });

  test("does NOT fire listeners when transitioning true→false", () => {
    setDiskSpaceWarning(true);
    let fired = 0;
    const unsub = onDiskFull(() => {
      fired++;
    });
    setDiskSpaceWarning(false);
    expect(fired).toBe(0);
    unsub();
  });

  test("swallows a listener that throws — setDiskSpaceWarning does not throw", () => {
    const unsub = onDiskFull(() => {
      throw new Error("listener explosion");
    });
    expect(() => setDiskSpaceWarning(true)).not.toThrow();
    unsub();
  });

  test("fires multiple listeners and swallows a throwing one without skipping later ones", () => {
    const calls: string[] = [];
    const unsub1 = onDiskFull(() => {
      calls.push("before");
    });
    const unsub2 = onDiskFull(() => {
      throw new Error("middle explodes");
    });
    const unsub3 = onDiskFull(() => {
      calls.push("after");
    });

    expect(() => setDiskSpaceWarning(true)).not.toThrow();
    expect(calls).toEqual(["before", "after"]);

    unsub1();
    unsub2();
    unsub3();
  });
});

describe("onDiskFull — unsubscribe", () => {
  afterEach(() => {
    setDiskSpaceWarning(false);
  });

  test("unsubscribed listener is not called on subsequent false→true transition", () => {
    let fired = 0;
    const unsub = onDiskFull(() => {
      fired++;
    });
    unsub();
    setDiskSpaceWarning(true);
    expect(fired).toBe(0);
  });

  test("calling unsubscribe twice is a safe no-op", () => {
    const unsub = onDiskFull(() => {
      /* nothing */
    });
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isSqliteFull / handleWriteError — fake-db error-path coverage
// ---------------------------------------------------------------------------

describe("DiskFullError via fake db — numeric code paths", () => {
  afterEach(() => {
    setDiskSpaceWarning(false);
  });

  test("dbRun throws DiskFullError and sets warning when error.code === 13 (SQLITE_FULL low-byte)", () => {
    const err: unknown = Object.assign(new Error("disk full"), { code: 13 });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    expect(() => dbRun(fakeDb, "INSERT INTO t VALUES (1)")).toThrow(DiskFullError);
    expect(isDiskSpaceWarning()).toBe(true);
  });

  test("dbRun DiskFullError carries the original error as cause", () => {
    const original: unknown = Object.assign(new Error("disk full"), { code: 13 });
    const fakeDb = {
      run() {
        throw original;
      },
      exec() {
        throw original;
      },
    } as unknown as Database;
    let caught: unknown;
    try {
      dbRun(fakeDb, "INSERT INTO t VALUES (1)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiskFullError);
    expect((caught as DiskFullError).cause).toBe(original);
  });

  test("dbRun throws DiskFullError for code with SQLITE_FULL in high bits (code & 0xff === 13)", () => {
    // e.g. SQLITE_FULL | extended-error-code = 0x010D (269)
    const err: unknown = Object.assign(new Error("disk full extended"), { code: 269 });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    expect(() => dbRun(fakeDb, "INSERT INTO t VALUES (1)")).toThrow(DiskFullError);
  });

  test("dbExec throws DiskFullError and sets warning when error.code === 13", () => {
    const err: unknown = Object.assign(new Error("disk full"), { code: 13 });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    expect(() => dbExec(fakeDb, "INSERT INTO t VALUES (1)")).toThrow(DiskFullError);
    expect(isDiskSpaceWarning()).toBe(true);
  });

  test("dbStmtRun throws DiskFullError and sets warning when error.code === 13", () => {
    const err: unknown = Object.assign(new Error("disk full"), { code: 13 });
    const fakeStmt: { run: () => unknown } = {
      run() {
        throw err;
      },
    };
    expect(() => dbStmtRun(fakeStmt)).toThrow(DiskFullError);
    expect(isDiskSpaceWarning()).toBe(true);
  });
});

describe("DiskFullError via fake db — string code path", () => {
  afterEach(() => {
    setDiskSpaceWarning(false);
  });

  test("dbRun throws DiskFullError when error.code === 'SQLITE_FULL'", () => {
    const err: unknown = Object.assign(new Error("disk full string"), { code: "SQLITE_FULL" });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    expect(() => dbRun(fakeDb, "INSERT INTO t VALUES (1)")).toThrow(DiskFullError);
    expect(isDiskSpaceWarning()).toBe(true);
  });

  test("dbExec throws DiskFullError when error.code === 'SQLITE_FULL'", () => {
    const err: unknown = Object.assign(new Error("disk full string"), { code: "SQLITE_FULL" });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    expect(() => dbExec(fakeDb, "INSERT INTO t VALUES (1)")).toThrow(DiskFullError);
  });

  test("non-SQLITE_FULL string code is rethrown verbatim by dbRun", () => {
    const err: unknown = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    let caught: unknown;
    try {
      dbRun(fakeDb, "INSERT INTO t VALUES (1)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(DiskFullError);
  });
});

describe("isSqliteFull — non-object error paths", () => {
  afterEach(() => {
    setDiskSpaceWarning(false);
  });

  test("dbRun rethrows a thrown string (non-object) verbatim", () => {
    const fakeDb = {
      run() {
        throw "raw string error";
      },
      exec() {
        throw "raw string error";
      },
    } as unknown as Database;
    let caught: unknown;
    try {
      dbRun(fakeDb, "INSERT INTO t VALUES (1)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe("raw string error");
    expect(isDiskSpaceWarning()).toBe(false);
  });

  test("dbRun rethrows null verbatim (null is not an object for isSqliteFull)", () => {
    const fakeDb = {
      run() {
        throw null;
      },
      exec() {
        throw null;
      },
    } as unknown as Database;
    let caught: unknown;
    try {
      dbRun(fakeDb, "INSERT INTO t VALUES (1)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeNull();
    expect(isDiskSpaceWarning()).toBe(false);
  });

  test("dbRun rethrows a non-SQLITE_FULL numeric code verbatim", () => {
    // code 5 = SQLITE_BUSY — should NOT trigger DiskFullError
    const err: unknown = Object.assign(new Error("busy"), { code: 5 });
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    let caught: unknown;
    try {
      dbRun(fakeDb, "INSERT INTO t VALUES (1)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(DiskFullError);
    expect(isDiskSpaceWarning()).toBe(false);
  });

  test("dbRun rethrows an object with no code property verbatim", () => {
    const err: unknown = { message: "no code here" };
    const fakeDb = {
      run() {
        throw err;
      },
      exec() {
        throw err;
      },
    } as unknown as Database;
    let caught: unknown;
    try {
      dbRun(fakeDb, "INSERT INTO t VALUES (1)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(DiskFullError);
  });
});
