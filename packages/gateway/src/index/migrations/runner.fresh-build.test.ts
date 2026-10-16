/**
 * The fresh-build durability relaxation in `runner.ts` (`isFreshIndexDatabase`,
 * `withRelaxedSyncForFreshBuild`). A brand-new index runs every migration step from version 0,
 * each in its own transaction, so under SQLite's default `synchronous = FULL` a first boot pays a
 * disk flush per step for a database that holds nothing. The runner builds such a database with
 * `synchronous = OFF` and hands the connection back at the level it arrived with.
 *
 * Two TEMP triggers on `main._schema_migrations` make the chain observable without touching the
 * runner: every step's last write is its own ledger row, so an AFTER INSERT trigger reads the level
 * each step COMMITS under, and a BEFORE INSERT trigger can RAISE inside a chosen step. TEMP objects
 * live in `sqlite_temp_master`, not `sqlite_master`, so neither instrument stops the database
 * counting as fresh — the property each test below depends on, and asserts where it matters.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import {
  isFreshIndexDatabase,
  MigrationRollbackError,
  readIndexedUserVersion,
  runIndexedSchemaMigrations,
  withRelaxedSyncForFreshBuild,
} from "./runner.ts";

/** `PRAGMA synchronous` levels, as SQLite reports them. */
const OFF = 0;
const NORMAL = 1;
const FULL = 2;
const EXTRA = 3;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-fresh-build-"));
});

afterEach(() => {
  // Every test closes its handle first; the retry covers Windows releasing it a moment late, which
  // Bun's own rmSync does not (it ignores maxRetries).
  rmDirWithRetry(tmpDir);
});

function dbPath(): string {
  return join(tmpDir, "nimbus.db");
}

function synchronousLevel(db: Database): number {
  return (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
}

/** Size of the `-wal` sidecar, 0 when there is none. */
function walBytes(path: string): number {
  const wal = `${path}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

/** Turns WAL on and proves it took, so a WAL assertion below can never pass on a rollback journal. */
function enableWal(db: Database): void {
  const row = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");
}

/**
 * Leaves the database holding only the `_schema_migrations` ledger — exactly what the runner
 * creates before it decides freshness — so the TEMP triggers below have a table to hang off.
 */
function createLedgerOnly(db: Database): void {
  runIndexedSchemaMigrations(db, 0);
}

/** Records the `synchronous` level every step commits under, keyed by the version it records. */
function observeStepLevels(db: Database): () => Array<{ version: number; level: number }> {
  db.run("CREATE TEMP TABLE step_level (version INTEGER NOT NULL, level INTEGER NOT NULL)");
  db.run(
    `CREATE TEMP TRIGGER observe_step_level AFTER INSERT ON main._schema_migrations
     BEGIN INSERT INTO step_level SELECT NEW.version, synchronous FROM pragma_synchronous; END`,
  );
  return () =>
    db.query("SELECT version, level FROM step_level ORDER BY version").all() as Array<{
      version: number;
      level: number;
    }>;
}

/** Makes the step that records `version` fail inside its own transaction. */
function failStep(db: Database, version: number): void {
  db.run(
    `CREATE TEMP TRIGGER fail_step BEFORE INSERT ON main._schema_migrations
     WHEN NEW.version = ${String(version)}
     BEGIN SELECT RAISE(ABORT, 'injected step failure'); END`,
  );
}

function versions(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// ---------------------------------------------------------------------------
// isFreshIndexDatabase
// ---------------------------------------------------------------------------

describe("isFreshIndexDatabase", () => {
  test("an empty file database is fresh", () => {
    const db = new Database(dbPath());
    try {
      expect(isFreshIndexDatabase(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a database holding only the _schema_migrations ledger is fresh", () => {
    const db = new Database(dbPath());
    try {
      createLedgerOnly(db);
      expect(isFreshIndexDatabase(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("SQLite's own sqlite_* objects (sqlite_stat1 from ANALYZE) do not count", () => {
    const db = new Database(dbPath());
    try {
      createLedgerOnly(db);
      db.run("ANALYZE");
      const names = (db.query("SELECT name FROM sqlite_master").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(names).toContain("sqlite_stat1"); // the premise: ANALYZE really added one
      expect(isFreshIndexDatabase(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a database past version 0 is not fresh, even with no other table", () => {
    const db = new Database(dbPath());
    try {
      createLedgerOnly(db);
      db.run("PRAGMA user_version = 1");
      expect(isFreshIndexDatabase(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a version-0 database holding a table of its own is not fresh", () => {
    const db = new Database(dbPath());
    try {
      createLedgerOnly(db);
      db.run("CREATE TABLE notes (body TEXT)");
      expect(readIndexedUserVersion(db)).toBe(0);
      expect(isFreshIndexDatabase(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a version-0 database holding any other schema object (a view) is not fresh", () => {
    const db = new Database(dbPath());
    try {
      db.run("CREATE VIEW answer AS SELECT 42 AS n");
      expect(isFreshIndexDatabase(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// withRelaxedSyncForFreshBuild
// ---------------------------------------------------------------------------

describe("withRelaxedSyncForFreshBuild", () => {
  test.each([OFF, NORMAL, FULL, EXTRA])(
    "a fresh build runs at OFF and puts back the caller's level %d, not a hard-coded FULL",
    (level) => {
      const db = new Database(dbPath());
      try {
        db.run(`PRAGMA synchronous = ${String(level)}`);
        const inside = withRelaxedSyncForFreshBuild(db, true, () => synchronousLevel(db));
        expect(inside).toBe(OFF);
        expect(synchronousLevel(db)).toBe(level);
      } finally {
        db.close();
      }
    },
  );

  test("a database that is not fresh runs at the caller's level throughout", () => {
    const db = new Database(dbPath());
    try {
      db.run("PRAGMA synchronous = NORMAL");
      const inside = withRelaxedSyncForFreshBuild(db, false, () => synchronousLevel(db));
      expect(inside).toBe(NORMAL);
      expect(synchronousLevel(db)).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  test("a throwing build still gets the caller's level back, and the SAME error propagates", () => {
    const db = new Database(dbPath());
    try {
      db.run("PRAGMA synchronous = NORMAL");
      const boom = new Error("step failed");
      let levelInside = -1;
      let caught: unknown;
      try {
        withRelaxedSyncForFreshBuild(db, true, () => {
          levelInside = synchronousLevel(db);
          throw boom;
        });
      } catch (err) {
        caught = err;
      }
      expect(levelInside).toBe(OFF); // the relaxation really was in force when it threw
      expect(caught).toBe(boom);
      expect(synchronousLevel(db)).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  test("inside the caller's open transaction it does not relax (SQLite refuses to there)", () => {
    const db = new Database(dbPath());
    try {
      db.run("PRAGMA synchronous = NORMAL");
      db.run("BEGIN");
      const inside = withRelaxedSyncForFreshBuild(db, true, () => synchronousLevel(db));
      db.run("COMMIT");
      expect(inside).toBe(NORMAL);
      expect(synchronousLevel(db)).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  test("a fresh WAL build is checkpointed before it returns; a non-fresh one is left alone", () => {
    const path = dbPath();
    const db = new Database(path);
    try {
      enableWal(db);
      withRelaxedSyncForFreshBuild(db, true, () => {
        db.run("CREATE TABLE t (x INTEGER)");
        db.run("INSERT INTO t VALUES (1)");
      });
      expect(walBytes(path)).toBe(0);

      withRelaxedSyncForFreshBuild(db, false, () => {
        db.run("INSERT INTO t VALUES (2)");
      });
      // Control: the same writes outside a fresh build stay in the log, so the 0 above is the
      // checkpoint's doing and not WAL quietly being off.
      expect(walBytes(path)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("an in-memory database relaxes and restores without error", () => {
    const db = new Database(":memory:");
    try {
      const inside = withRelaxedSyncForFreshBuild(db, true, () => synchronousLevel(db));
      expect(inside).toBe(OFF);
      expect(synchronousLevel(db)).toBe(FULL);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runIndexedSchemaMigrations — the relaxation in the real chain
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — fresh-build durability", () => {
  test("a fresh on-disk build restores the caller's NORMAL and reaches CURRENT_SCHEMA_VERSION", () => {
    const db = new Database(dbPath());
    try {
      db.run("PRAGMA synchronous = NORMAL");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(synchronousLevel(db)).toBe(NORMAL);
      expect(readIndexedUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("every step of a fresh build commits at synchronous OFF", () => {
    const db = new Database(dbPath());
    try {
      db.run("PRAGMA synchronous = NORMAL");
      createLedgerOnly(db);
      const stepLevels = observeStepLevels(db);
      expect(isFreshIndexDatabase(db)).toBe(true); // the TEMP instrument left it fresh

      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

      expect(stepLevels()).toEqual(
        versions(1, CURRENT_SCHEMA_VERSION).map((version) => ({ version, level: OFF })),
      );
      expect(synchronousLevel(db)).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  test("an upgrade commits every step at the caller's level — it is never relaxed", () => {
    const db = new Database(dbPath());
    try {
      runIndexedSchemaMigrations(db, 60);
      db.run("PRAGMA synchronous = NORMAL");
      const stepLevels = observeStepLevels(db);

      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

      expect(stepLevels()).toEqual(
        versions(61, CURRENT_SCHEMA_VERSION).map((version) => ({ version, level: NORMAL })),
      );
      expect(synchronousLevel(db)).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  test("a version-0 database that already holds a table keeps full durability for every step", () => {
    const db = new Database(dbPath());
    try {
      db.run("CREATE TABLE notes (body TEXT)");
      db.run("INSERT INTO notes VALUES ('keep me')");
      createLedgerOnly(db);
      const stepLevels = observeStepLevels(db);

      runIndexedSchemaMigrations(db, 10);

      expect(stepLevels()).toEqual(versions(1, 10).map((version) => ({ version, level: FULL })));
      expect(readIndexedUserVersion(db)).toBe(10);
    } finally {
      db.close();
    }
  });

  test("a step that fails mid-build restores the caller's level and its MigrationRollbackError propagates", () => {
    const db = new Database(dbPath());
    try {
      db.run("PRAGMA synchronous = NORMAL");
      createLedgerOnly(db);
      const stepLevels = observeStepLevels(db);
      failStep(db, 5);
      expect(isFreshIndexDatabase(db)).toBe(true);

      let caught: unknown;
      try {
        runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MigrationRollbackError);
      const rollback = caught as MigrationRollbackError;
      expect(rollback.migrationVersion).toBe(5);
      expect(String(rollback.cause)).toContain("injected step failure");
      // Steps 1–4 committed under the relaxation, so the restore below is not vacuous.
      expect(stepLevels()).toEqual(versions(1, 4).map((version) => ({ version, level: OFF })));
      expect(readIndexedUserVersion(db)).toBe(4);
      expect(synchronousLevel(db)).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  test("a fresh WAL build leaves an empty write-ahead log and the caller's level behind", () => {
    const path = dbPath();
    const db = new Database(path);
    try {
      enableWal(db);
      db.run("PRAGMA synchronous = NORMAL");

      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

      // Checked BEFORE close: closing the last connection checkpoints on its own, which would
      // make this pass whether or not the runner did.
      expect(walBytes(path)).toBe(0);
      expect(synchronousLevel(db)).toBe(NORMAL);
      expect(readIndexedUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("an in-memory fresh build still reaches CURRENT_SCHEMA_VERSION", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(readIndexedUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(synchronousLevel(db)).toBe(FULL);
    } finally {
      db.close();
    }
  });

  test("a fresh build inside the caller's open transaction still migrates", () => {
    const db = new Database(dbPath());
    try {
      db.run("BEGIN");
      runIndexedSchemaMigrations(db, 5);
      db.run("COMMIT");
      expect(readIndexedUserVersion(db)).toBe(5);
      expect(synchronousLevel(db)).toBe(FULL);
    } finally {
      db.close();
    }
  });
});
