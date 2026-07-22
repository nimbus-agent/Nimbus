import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWritablePragmas, BUSY_TIMEOUT_MS, readJournalMode } from "./writable-pragmas.ts";

describe("applyWritablePragmas", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-wal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file-backed handle actually adopts WAL", () => {
    const db = new Database(join(dir, "nimbus.db"));
    // The return value is the mode SQLite ADOPTED, not the one requested — a
    // declined request is the failure mode this whole change exists to catch.
    expect(applyWritablePragmas(db)).toBe("wal");
    expect(readJournalMode(db)).toBe("wal");
    db.close();
  });

  test("WAL persists to the FILE, so a later handle inherits it without asking", () => {
    const path = join(dir, "nimbus.db");
    const writer = new Database(path);
    applyWritablePragmas(writer);
    writer.run("CREATE TABLE t (x INTEGER)");
    writer.close();

    // This is why read-only handles need no pragma of their own: they cannot
    // set journal_mode, and do not have to.
    const reader = new Database(path, { readonly: true, create: false });
    expect(readJournalMode(reader)).toBe("wal");
    reader.close();
  });

  test("busy_timeout is applied", () => {
    const db = new Database(join(dir, "nimbus.db"));
    applyWritablePragmas(db);
    const row = db.query("PRAGMA busy_timeout;").get() as { timeout?: number } | null;
    expect(row?.timeout).toBe(BUSY_TIMEOUT_MS);
    db.close();
  });

  test("readJournalMode reports 'unknown' rather than throwing on an empty result", () => {
    // Defensive path: PRAGMA journal_mode always returns a row in practice, so
    // it takes a stub to reach. Left in (and covered) because the alternative
    // is a TypeError deep in gateway startup if that ever stops being true.
    const stub = { query: () => ({ get: () => null }) } as unknown as Database;
    expect(readJournalMode(stub)).toBe("unknown");

    const noField = { query: () => ({ get: () => ({}) }) } as unknown as Database;
    expect(readJournalMode(noField)).toBe("unknown");
  });

  test("an in-memory database degrades instead of throwing", () => {
    // :memory: cannot do WAL. Startup must survive that, so the helper reports
    // the adopted mode rather than raising.
    const db = new Database(":memory:");
    expect(() => applyWritablePragmas(db)).not.toThrow();
    expect(applyWritablePragmas(db)).not.toBe("wal");
    db.close();
  });

  test("a reader sees a committed row while the writer holds an open transaction", () => {
    // The actual point of WAL: under the rollback journal this read blocks (and
    // with busy_timeout=0 on the reader, fails outright) until the writer ends.
    const path = join(dir, "nimbus.db");
    const writer = new Database(path);
    applyWritablePragmas(writer);
    writer.run("CREATE TABLE t (x INTEGER)");
    writer.run("INSERT INTO t (x) VALUES (1)");

    const reader = new Database(path, { readonly: true, create: false });

    writer.run("BEGIN IMMEDIATE");
    writer.run("INSERT INTO t (x) VALUES (2)");

    // Committed-before-BEGIN data stays readable mid-write; the uncommitted row does not.
    const seen = reader.query("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    expect(seen.n).toBe(1);

    writer.run("COMMIT");
    reader.close();
    writer.close();
  });
});

describe("production writable handles wire the pragmas", () => {
  // A unit test of the helper proves the helper works, not that anything calls
  // it. These are the three production sites that hold a WRITABLE handle on
  // nimbus.db; deleting a call here is exactly the regression #426 describes,
  // and it would otherwise fail silently.
  const SITES = [
    "platform/assemble.ts",
    "embedding/embedding-worker.ts",
    "ipc/http-server.ts",
  ] as const;

  for (const site of SITES) {
    test(`${site} calls applyWritablePragmas`, () => {
      const src = readFileSync(join(import.meta.dir, "..", site), "utf8");
      // Match the CALL, not the mention: asserting on the bare identifier is
      // satisfied by the leftover `import { applyWritablePragmas }` line, so
      // deleting the call still passed. Verified by re-running this red.
      expect(src).toContain("applyWritablePragmas(");
    });
  }
});
