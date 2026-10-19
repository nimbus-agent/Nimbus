import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

import {
  applyWritablePragmas,
  BUSY_TIMEOUT_MS,
  optimizeQueryPlanner,
  PAGE_CACHE_KIB,
  purgeDeletedResidue,
  readJournalMode,
  withSecureDelete,
} from "./writable-pragmas.ts";

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

describe("throughput pragmas", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-pragmas-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a WAL handle gets synchronous=NORMAL, in-memory temp store and the larger cache", () => {
    const db = new Database(join(dir, "nimbus.db"));
    expect(applyWritablePragmas(db)).toBe("wal");
    // 1 = NORMAL, 2 = MEMORY.
    expect(db.query("PRAGMA synchronous;").get()).toEqual({ synchronous: 1 });
    expect(db.query("PRAGMA temp_store;").get()).toEqual({ temp_store: 2 });
    expect(db.query("PRAGMA cache_size;").get()).toEqual({ cache_size: -PAGE_CACHE_KIB });
    db.close();
  });

  test("a handle that could not adopt WAL keeps the corruption-safe default synchronous=FULL", () => {
    const db = new Database(":memory:");
    expect(applyWritablePragmas(db)).toBe("memory");
    // 2 = FULL, SQLite's default; NORMAL is only safe under WAL.
    expect(db.query("PRAGMA synchronous;").get()).toEqual({ synchronous: 2 });
    db.close();
  });

  test("optimizeQueryPlanner analyzes a never-analyzed table and never throws", () => {
    const db = new Database(join(dir, "nimbus.db"));
    applyWritablePragmas(db);
    db.run("CREATE TABLE t (x INTEGER)");
    db.run("CREATE INDEX t_x ON t(x)");
    for (let i = 0; i < 50; i++) db.run("INSERT INTO t VALUES (?)", [i]);
    optimizeQueryPlanner(db);
    optimizeQueryPlanner(db, "close");
    db.close();
    const closed = new Database(":memory:");
    closed.close();
    expect(() => optimizeQueryPlanner(closed)).not.toThrow();
  });
});

describe("deleted data is not left on disk (audit P2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-secure-delete-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const MARKER = "zqxsecretmarkerzqx";

  /** Does the marker survive anywhere in the database file or its WAL? */
  function markerOnDisk(path: string): boolean {
    return [path, `${path}-wal`].some(
      (p) => existsSync(p) && readFileSync(p).includes(Buffer.from(MARKER)),
    );
  }

  /** An indexed item whose body carries the marker, deleted the way `nimbus data delete` does. */
  function seedAndDelete(path: string, scrub: boolean): void {
    const db = new Database(path);
    applyWritablePragmas(db);
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    for (let i = 0; i < 40; i++) {
      upsertIndexedItem(db, {
        service: i === 7 ? "gmail" : "slack",
        type: "message",
        externalId: `m${String(i)}`,
        title: `message ${String(i)}`,
        body: i === 7 ? `the body holds ${MARKER} and more text` : `ordinary text ${String(i)}`,
        modifiedAt: i,
        syncedAt: i,
      });
    }
    dbCheckpoint(db);
    const del = (): void => {
      db.run("DELETE FROM item WHERE service = 'gmail'");
    };
    if (scrub) {
      withSecureDelete(db, del);
      purgeDeletedResidue(db);
    } else {
      db.run("PRAGMA secure_delete = OFF");
      del();
      dbCheckpoint(db);
    }
    db.close();
  }

  function dbCheckpoint(db: Database): void {
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  }

  test("control: without secure_delete the deleted body is still readable in the file", () => {
    const path = join(dir, "control.db");
    seedAndDelete(path, false);
    expect(markerOnDisk(path)).toBe(true);
  });

  test("with secure_delete ON and the residue purge, the deleted body is gone from file and WAL", () => {
    const path = join(dir, "nimbus.db");
    seedAndDelete(path, true);
    expect(markerOnDisk(path)).toBe(false);
  });

  test("every writable handle defaults to secure_delete FAST, and withSecureDelete restores it", () => {
    const db = new Database(join(dir, "fast.db"));
    applyWritablePragmas(db);
    // 2 = FAST, 1 = ON.
    expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 2 });
    const inside = withSecureDelete(db, () => db.query("PRAGMA secure_delete").get());
    expect(inside).toEqual({ secure_delete: 1 });
    expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 2 });
    expect(() =>
      withSecureDelete(db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 2 });
    db.close();
  });

  test("purgeDeletedResidue reports what it did and tolerates a schema with no item_fts", () => {
    const db = new Database(join(dir, "bare.db"));
    applyWritablePragmas(db);
    db.run("CREATE TABLE t (x)");
    expect(purgeDeletedResidue(db)).toEqual({ ftsMerged: false, walTruncated: true });
    db.close();
    const mem = new Database(":memory:");
    expect(purgeDeletedResidue(mem)).toEqual({ ftsMerged: false, walTruncated: false });
    mem.close();
  });
});
