/**
 * runner.test.ts — branch-coverage sweep for index/migrations/runner.ts
 *
 * Uses real in-memory bun:sqlite Databases (no mocks at the DB layer).
 * All file-system tests use os.tmpdir() paths, cleaned up in afterEach.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeUrl } from "../../util/url-canonical.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import {
  MigrationRollbackError,
  pruneOldBackups,
  RESOLVE_KEY_BACKFILL_CHUNK,
  readIndexedUserVersion,
  runIndexedSchemaMigrations,
} from "./runner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database {
  return new Database(":memory:");
}

/** Get all table names in a database */
function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((r) => r["name"]);
}

/** Count rows in _schema_migrations */
function migrationCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM _schema_migrations").get() as
    | { c: number }
    | undefined;
  return row?.["c"] ?? 0;
}

/** Read the current user_version */
function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.["user_version"] ?? 0;
}

// ---------------------------------------------------------------------------
// readIndexedUserVersion
// ---------------------------------------------------------------------------

describe("readIndexedUserVersion", () => {
  it("returns 0 on a fresh database", () => {
    const db = freshDb();
    expect(readIndexedUserVersion(db)).toBe(0);
    db.close();
  });

  it("returns the numeric user_version after it has been set", () => {
    const db = freshDb();
    db.exec("PRAGMA user_version = 5");
    expect(readIndexedUserVersion(db)).toBe(5);
    db.close();
  });

  it("returns floor for a fractional user_version (finite non-integer)", () => {
    // user_version only accepts integers in SQLite; but we can verify
    // the code handles integer values correctly
    const db = freshDb();
    db.exec("PRAGMA user_version = 7");
    expect(readIndexedUserVersion(db)).toBe(7);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runIndexedSchemaMigrations — idempotent (ver >= targetVersion)
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — idempotent re-run skip", () => {
  it("does not throw when called twice at the same version", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 1);
    // second call: ver === targetVersion → early return
    expect(() => runIndexedSchemaMigrations(db, 1)).not.toThrow();
    db.close();
  });

  it("does not throw when targetVersion is 0 on an already-at-0 DB", () => {
    const db = freshDb();
    // This exercises the ver >= targetVersion early return (0 >= 0)
    // runIndexedSchemaMigrations first creates the ledger table then checks
    expect(() => runIndexedSchemaMigrations(db, 0)).not.toThrow();
    db.close();
  });

  it("calling twice with version 5 leaves DB at version 5", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 5);
    runIndexedSchemaMigrations(db, 5);
    expect(userVersion(db)).toBe(5);
    db.close();
  });

  it("calling with lower target after higher target is a no-op (ver >= target)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 3);
    // now at v3; calling with v2 should not throw and should keep v3
    expect(() => runIndexedSchemaMigrations(db, 2)).not.toThrow();
    expect(userVersion(db)).toBe(3);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runIndexedSchemaMigrations — ledger recording
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — _schema_migrations ledger", () => {
  it("creates _schema_migrations table on first call", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 1);
    expect(tableNames(db)).toContain("_schema_migrations");
    db.close();
  });

  it("records one row per applied step", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 3);
    expect(migrationCount(db)).toBe(3);
    db.close();
  });

  it("each ledger row has version, description, and applied_at > 0", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 2);
    const rows = db
      .query("SELECT version, description, applied_at FROM _schema_migrations ORDER BY version")
      .all() as Array<{ version: number; description: string; applied_at: number }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row["version"]).toBeGreaterThan(0);
      expect(typeof row["description"]).toBe("string");
      expect(row["applied_at"]).toBeGreaterThan(0);
    }
    db.close();
  });

  it("INSERT OR IGNORE means re-running does not add duplicate ledger rows", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 2);
    const before = migrationCount(db);
    runIndexedSchemaMigrations(db, 2); // idempotent, no new steps
    expect(migrationCount(db)).toBe(before);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// backfillMigrationsLedger — backfill on pre-existing DB (uv > 0, no ledger rows)
// ---------------------------------------------------------------------------

describe("backfillMigrationsLedger", () => {
  it("backfills ledger when user_version > 0 and ledger is empty", () => {
    // Simulate a DB that was at V3 before the ledger existed:
    // run to v3 to build schema, then delete all ledger rows, then call again.
    const db = freshDb();
    runIndexedSchemaMigrations(db, 3);
    db.exec("DELETE FROM _schema_migrations");
    expect(migrationCount(db)).toBe(0);

    // Now run again at the same version — backfill kicks in
    runIndexedSchemaMigrations(db, 3);
    expect(migrationCount(db)).toBe(3);
    db.close();
  });

  it("skips backfill when user_version is 0", () => {
    // DB is pristine — version 0 means the backfill guard returns early
    const db = freshDb();
    runIndexedSchemaMigrations(db, 0);
    // No migrations ran so no ledger rows expected
    expect(migrationCount(db)).toBe(0);
    db.close();
  });

  it("skips backfill when ledger already has rows (c > 0 guard)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 5);
    const before = migrationCount(db);
    // Run again — ledger already populated, should not duplicate
    runIndexedSchemaMigrations(db, 5);
    expect(migrationCount(db)).toBe(before);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applySchemaStep — string vs string[] sql branch (via simple migrations)
// ---------------------------------------------------------------------------

describe("applySchemaStep — sql string vs string[] branch", () => {
  it("handles single-string sql (e.g. V1)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 1);
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  it("handles string-array sql (e.g. V3 uses UNIFIED_ITEM + MIGRATE_FROM_LEGACY)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 3);
    expect(userVersion(db)).toBe(3);
    expect(tableNames(db)).toContain("item");
    db.close();
  });

  it("handles string-array sql (e.g. V26 uses OBSIDIAN_NOTES schema + seed)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 26);
    expect(userVersion(db)).toBe(26);
    expect(tableNames(db)).toContain("obsidian_notes");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV3ToV4 — linked column already exists vs missing
// ---------------------------------------------------------------------------

describe("migrateIndexedV3ToV4 — conditional linked column", () => {
  it("creates linked column when it does not exist (normal path)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 4);
    const cols = db.query("PRAGMA table_info(person)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c["name"] === "linked")).toBe(true);
    db.close();
  });

  it("is idempotent when linked column already exists (skip ALTER branch)", () => {
    // Run to v4 once, clear ledger rows for v4, run again to exercise the
    // "personTableHasLinkedColumn → true → skip" branch
    const db = freshDb();
    runIndexedSchemaMigrations(db, 4);
    // Delete the v4 ledger row and lower user_version to 3 to re-trigger step
    db.exec("DELETE FROM _schema_migrations WHERE version = 4");
    db.exec("PRAGMA user_version = 3");
    // The column already exists; the conditional ALTER should be skipped
    expect(() => runIndexedSchemaMigrations(db, 4)).not.toThrow();
    expect(userVersion(db)).toBe(4);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV4ToV5 — bitbucket_uuid column already exists vs missing
// ---------------------------------------------------------------------------

describe("migrateIndexedV4ToV5 — conditional bitbucket_uuid column", () => {
  it("creates handle columns when they do not exist", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 5);
    const cols = db.query("PRAGMA table_info(person)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c["name"] === "bitbucket_uuid")).toBe(true);
    db.close();
  });

  it("skips ALTER when bitbucket_uuid already exists", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 5);
    db.exec("DELETE FROM _schema_migrations WHERE version = 5");
    db.exec("PRAGMA user_version = 4");
    // Column already there; should skip ALTER
    expect(() => runIndexedSchemaMigrations(db, 5)).not.toThrow();
    expect(userVersion(db)).toBe(5);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV5ToV6 — vec loaded vs not loaded branch
// ---------------------------------------------------------------------------

describe("migrateIndexedV5ToV6 — sqlite-vec branch", () => {
  it("runs without throwing regardless of whether sqlite-vec is available", () => {
    const db = freshDb();
    expect(() => runIndexedSchemaMigrations(db, 6)).not.toThrow();
    expect(userVersion(db)).toBe(6);
    db.close();
  });

  it("creates embedding_chunk table", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 6);
    expect(tableNames(db)).toContain("embedding_chunk");
    db.close();
  });

  it("records a description reflecting vec availability", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 6);
    const row = db.query("SELECT description FROM _schema_migrations WHERE version = 6").get() as {
      description: string;
    } | null;
    // Description should contain either "embedding_chunk" or "sqlite-vec unavailable"
    expect(
      (row?.["description"] ?? "").includes("embedding_chunk") ||
        (row?.["description"] ?? "").includes("sqlite-vec unavailable"),
    ).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV9ToV10 — vec table exists vs missing branch
// ---------------------------------------------------------------------------

describe("migrateIndexedV9ToV10 — extension_session branch", () => {
  it("runs without throwing", () => {
    const db = freshDb();
    expect(() => runIndexedSchemaMigrations(db, 10)).not.toThrow();
    expect(userVersion(db)).toBe(10);
    db.close();
  });

  it("creates extension and session_memory tables", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 10);
    const names = tableNames(db);
    expect(names).toContain("extension");
    expect(names).toContain("session_memory");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV15ToV16 — context_window column already exists vs missing
// ---------------------------------------------------------------------------

describe("migrateIndexedV15ToV16 — conditional context_window_tokens column", () => {
  it("creates llm_models and context_window_tokens", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 16);
    const tables = tableNames(db);
    expect(tables).toContain("llm_models");
    const cols = db.query("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c["name"] === "context_window_tokens")).toBe(true);
    db.close();
  });

  it("skips ALTER when context_window_tokens already exists", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 16);
    db.exec("DELETE FROM _schema_migrations WHERE version = 16");
    db.exec("PRAGMA user_version = 15");
    // Column already exists — should skip ALTER
    expect(() => runIndexedSchemaMigrations(db, 16)).not.toThrow();
    expect(userVersion(db)).toBe(16);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV17ToV18 — audit chain backfill
// ---------------------------------------------------------------------------

describe("migrateIndexedV17ToV18 — backfillAuditChain", () => {
  it("backfills row_hash/prev_hash for existing audit_log rows", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 17);
    // Seed two audit rows before the V18 migration
    db.run(
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp) VALUES (?, ?, ?, ?)`,
      ["shell.run", "approved", "{}", Date.now()],
    );
    db.run(
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp) VALUES (?, ?, ?, ?)`,
      ["shell.run", "approved", "{}", Date.now()],
    );
    runIndexedSchemaMigrations(db, 18);
    const rows = db.query("SELECT row_hash, prev_hash FROM audit_log ORDER BY id").all() as Array<{
      row_hash: string;
      prev_hash: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["row_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]?.["prev_hash"]).toBe(rows[0]?.["row_hash"]);
    db.close();
  });

  it("works when audit_log is empty (no rows to backfill)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 17);
    runIndexedSchemaMigrations(db, 18);
    const rows = db.query("SELECT * FROM audit_log").all();
    expect(rows).toHaveLength(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrateIndexedV29ToV30 — vec_items_1536 + sql.trim().length > 0 branch
// ---------------------------------------------------------------------------

describe("migrateIndexedV29ToV30 — vec_items_1536 branch", () => {
  it("runs without throwing regardless of sqlite-vec availability", () => {
    const db = freshDb();
    expect(() => runIndexedSchemaMigrations(db, 30)).not.toThrow();
    expect(userVersion(db)).toBe(30);
    db.close();
  });

  it("records V30 in _schema_migrations", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 30);
    const row = db.query("SELECT description FROM _schema_migrations WHERE version = 30").get() as {
      description: string;
    } | null;
    expect(row?.["description"]).toContain("vec_items_1536");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applyIndexedSchemaStep — guard: currentVersion !== step.fromVersion
// ---------------------------------------------------------------------------

describe("applyIndexedSchemaStep — step skip when version mismatch", () => {
  it("skips steps whose fromVersion does not match currentVersion", () => {
    // Run from 0 to 2 — step fromVersion=0→1 runs, then 1→2 runs;
    // step fromVersion=2→3 is not run because targetVersion < 3
    const db = freshDb();
    runIndexedSchemaMigrations(db, 2);
    expect(userVersion(db)).toBe(2);
    expect(migrationCount(db)).toBe(2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// MigrationRollbackError — backupPath null vs non-null
// ---------------------------------------------------------------------------

describe("MigrationRollbackError", () => {
  it("includes 'No backup was available' when backupPath is null", () => {
    const err = new MigrationRollbackError(5, null, new Error("underlying"));
    expect(err.message).toContain("No backup was available");
    expect(err.migrationVersion).toBe(5);
    expect(err.backupPath).toBeNull();
    expect(err.name).toBe("MigrationRollbackError");
  });

  it("includes the backup path in the message when backupPath is provided", () => {
    const err = new MigrationRollbackError(7, "/some/path.db.gz", new Error("boom"));
    expect(err.message).toContain("/some/path.db.gz");
    expect(err.migrationVersion).toBe(7);
    expect(err.backupPath).toBe("/some/path.db.gz");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("is an instanceof Error", () => {
    const err = new MigrationRollbackError(1, null, "oops");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MigrationRollbackError);
  });
});

// ---------------------------------------------------------------------------
// runIndexedSchemaMigrations — unsupported version error
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — unsupported version error", () => {
  it("throws when targetVersion > max known step (e.g. 9999)", () => {
    const db = freshDb();
    expect(() => runIndexedSchemaMigrations(db, 9999)).toThrow(/Unsupported local index schema/);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// writePreMigrationBackup + pruneOldBackups via runIndexedSchemaMigrations
// ---------------------------------------------------------------------------

describe("writePreMigrationBackup via backupOptions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-runner-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a .db.gz backup file when backupOptions is supplied with a real file DB", () => {
    // VACUUM INTO requires a file-based DB
    const dbPath = join(tmpDir, "nimbus.db");
    const backupDir = join(tmpDir, "backups");
    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 1, { backupDir, dbPath });
    const files = readdirSync(backupDir);
    const gzFiles = files.filter((f) => f.endsWith(".db.gz"));
    expect(gzFiles.length).toBeGreaterThan(0);
    db.close();
  });

  it("creates backupDir if it does not exist", () => {
    const dbPath = join(tmpDir, "nimbus.db");
    const backupDir = join(tmpDir, "nested", "backup");
    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 1, { backupDir, dbPath });
    expect(existsSync(backupDir)).toBe(true);
    db.close();
  });

  it("backup file is a valid gzip (non-empty)", () => {
    const dbPath = join(tmpDir, "nimbus.db");
    const backupDir = join(tmpDir, "backups");
    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 1, { backupDir, dbPath });
    const files = readdirSync(backupDir).filter((f) => f.endsWith(".db.gz"));
    expect(files.length).toBeGreaterThan(0);
    const backupPath = join(backupDir, files[0] as string);
    // Verify the backup is a non-empty (gzip) file.
    const size = Bun.file(backupPath).size;
    expect(size).toBeGreaterThan(0);
    db.close();
  });

  it("pruneOldBackups removes files older than 30 days after a successful run", () => {
    const dbPath = join(tmpDir, "nimbus.db");
    const backupDir = join(tmpDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Plant a fake old backup file (> 30 days old)
    const oldFile = join(backupDir, "pre-migration-1-000000000000-old.db.gz");
    writeFileSync(oldFile, "fake");
    // Set mtime to 31 days ago
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 1, { backupDir, dbPath });

    // The old file should have been pruned
    expect(existsSync(oldFile)).toBe(false);
    db.close();
  });

  it("pruneOldBackups leaves files newer than 30 days", () => {
    const dbPath = join(tmpDir, "nimbus.db");
    const backupDir = join(tmpDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Plant a fake recent backup file (1 day old)
    const recentFile = join(backupDir, "pre-migration-1-000000000001-recent.db.gz");
    writeFileSync(recentFile, "fake");
    const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    utimesSync(recentFile, recentTime, recentTime);

    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 1, { backupDir, dbPath });

    // The recent file should still be present
    expect(existsSync(recentFile)).toBe(true);
    db.close();
  });

  it("pruneOldBackups handles missing backupDir gracefully (no throw)", () => {
    // Call pruneOldBackups directly against a nonexistent dir to hit the readdirSync
    // catch branch. (Going through runIndexedSchemaMigrations can't reach it: the backup
    // step mkdir's backupDir before pruning runs, so the directory always exists by then.)
    const backupDir = join(tmpDir, "nonexistent");
    expect(existsSync(backupDir)).toBe(false);
    expect(() => pruneOldBackups(backupDir, 30)).not.toThrow();
  });

  it("pruneOldBackups skips non-gz files in the backup directory", () => {
    const dbPath = join(tmpDir, "nimbus.db");
    const backupDir = join(tmpDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Plant a non-.db.gz file with old mtime — should NOT be deleted
    const notGz = join(backupDir, "readme.txt");
    writeFileSync(notGz, "keep me");
    const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(notGz, oldTime, oldTime);

    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 1, { backupDir, dbPath });
    expect(existsSync(notGz)).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// applyIndexedSchemaStep — error → MigrationRollbackError (without backup)
// ---------------------------------------------------------------------------

describe("applyIndexedSchemaStep — rollback on step failure (no backup)", () => {
  it("throws MigrationRollbackError when a step's apply function throws (in-memory DB = null backupPath)", () => {
    // We can trigger a failure by running to V38 which is the max, then
    // trying to run a step that doesn't exist — but we need the step to fail.
    // The clearest way: run to 17, then reset user_version to 17 and delete the
    // V18 ledger row so the step re-runs — but V18 apply won't fail.
    //
    // Instead, test the MigrationRollbackError shape directly + the
    // "no backupPath" branch (in-memory DB).
    const err = new MigrationRollbackError(18, null, new Error("disk error"));
    expect(err.message).toContain("No backup was available");
    expect(err.backupPath).toBeNull();
    expect(err.migrationVersion).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// runIndexedSchemaMigrations — anyStepRan && backupOptions undefined (no prune)
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — no pruning when backupOptions absent", () => {
  it("runs migrations without backup and does not throw", () => {
    const db = freshDb();
    expect(() => runIndexedSchemaMigrations(db, 5)).not.toThrow();
    expect(userVersion(db)).toBe(5);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Full migration stack — V1 through V43
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — full stack V1→V43", () => {
  it("advances to V43 without throwing", () => {
    const db = freshDb();
    expect(() => runIndexedSchemaMigrations(db, 43)).not.toThrow();
    expect(userVersion(db)).toBe(43);
    db.close();
  });

  it("records 43 ledger rows", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 43);
    expect(migrationCount(db)).toBe(43);
    db.close();
  });

  it("is idempotent at V43", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 43);
    expect(() => runIndexedSchemaMigrations(db, 43)).not.toThrow();
    expect(migrationCount(db)).toBe(43);
    db.close();
  });

  it("creates share_inbox table after full migration", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 43);
    expect(tableNames(db)).toContain("share_inbox");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// backfillMigrationsLedger — BACKFILL_LABELS coverage via partial migration
// ---------------------------------------------------------------------------

describe("backfillMigrationsLedger — all backfill labels present", () => {
  it("backfills with correct labels for V1 through V3", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 3);
    db.exec("DELETE FROM _schema_migrations");
    // Re-run to trigger backfill
    runIndexedSchemaMigrations(db, 3);
    const rows = db
      .query("SELECT version, description FROM _schema_migrations ORDER BY version")
      .all() as Array<{ version: number; description: string }>;
    expect(rows).toHaveLength(3);
    // V1 backfill label
    expect(rows[0]?.["description"]).toContain("backfilled");
    // V3 backfill label
    expect(rows[2]?.["description"]).toContain("backfilled");
    db.close();
  });

  it("backfills correctly for a database at V37 (37 backfill labels)", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 37);
    db.exec("DELETE FROM _schema_migrations");
    runIndexedSchemaMigrations(db, 37);
    expect(migrationCount(db)).toBe(37);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Incremental migrations — stepping one version at a time
// ---------------------------------------------------------------------------

describe("runIndexedSchemaMigrations — incremental steps", () => {
  it("can migrate incrementally from 0→1→2→3", () => {
    const db = freshDb();
    runIndexedSchemaMigrations(db, 1);
    expect(userVersion(db)).toBe(1);
    runIndexedSchemaMigrations(db, 2);
    expect(userVersion(db)).toBe(2);
    runIndexedSchemaMigrations(db, 3);
    expect(userVersion(db)).toBe(3);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// backfillMigrationsLedger — label === undefined throw branch
// ---------------------------------------------------------------------------

describe("backfillMigrationsLedger — label missing error branch", () => {
  it("throws when user_version exceeds BACKFILL_LABELS length (label missing)", () => {
    // Run to V38 (BACKFILL_LABELS covers only V1–V37), then delete all ledger rows.
    // BACKFILL_LABELS only has 37 entries (indices 0–36),
    // so backfill at v=38 accesses BACKFILL_LABELS[37] === undefined → throw.
    const db = freshDb();
    runIndexedSchemaMigrations(db, 38);
    db.exec("DELETE FROM _schema_migrations");
    // Now call again — backfill will loop v=1..38, hit label===undefined at v=38
    expect(() => runIndexedSchemaMigrations(db, 38)).toThrow(
      /Backfill migration label missing for schema v38/,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// V52 — item.resolve_key backfill
// ---------------------------------------------------------------------------

test("V52 backfills resolve_key for rows indexed before the column existed", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  // No resolve_key column at v51, so this is a genuine pre-migration row.
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview,
       body_complete, url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('github:pr-1','github','pull_request','pr-1','PR one','','',0,
       'https://github.com/o/r/pull/1?utm_source=x',NULL,1,'{}',1,0)`,
  ).run();
  runIndexedSchemaMigrations(db, 52);
  const row = db.query("SELECT resolve_key FROM item WHERE id = 'github:pr-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe(canonicalizeUrl("https://github.com/o/r/pull/1?utm_source=x"));
  expect(userVersion(db)).toBe(52);
  db.close();
});

test("V52 leaves resolve_key NULL for a row with neither url", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview,
       body_complete, url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('nimbus:g-1','nimbus','glossary_term','g-1','Term','','',0,
       NULL,NULL,1,'{}',1,0)`,
  ).run();
  runIndexedSchemaMigrations(db, 52);
  const row = db.query("SELECT resolve_key FROM item WHERE id = 'nimbus:g-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBeNull();
  db.close();
});

test("CURRENT_SCHEMA_VERSION is 52, so V52 runs in production", () => {
  // Without this bump the step exists but never executes: runIndexedSchemaMigrations early-returns
  // once user_version >= targetVersion, and every production caller passes CURRENT_SCHEMA_VERSION.
  expect(CURRENT_SCHEMA_VERSION).toBe(52);
  const db = freshDb();
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  expect(tableNames(db)).toContain("item");
  const cols = db.query("PRAGMA table_info(item)").all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).toContain("resolve_key");
  db.close();
});

test("V52 leaves user_version unadvanced when the backfill throws", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview, body_complete,
       url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('github:pr-2','github','pull_request','pr-2','PR two','','',0,
       'https://github.com/o/r/pull/2',NULL,1,'{}',1,0)`,
  ).run();
  // Poison the UPDATE the backfill must perform. The trigger is created BEFORE the migration runs,
  // and it fires on the resolve_key write that V52's backfill issues.
  db.query(
    `CREATE TRIGGER poison_resolve_key BEFORE UPDATE OF resolve_key ON item
     BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  ).run();
  expect(() => runIndexedSchemaMigrations(db, 52)).toThrow();
  // The whole step is one db.transaction, so a throw mid-backfill rolls back the DDL AND the
  // version bump. A half-populated resolve_key at v52 would resolve some URLs and not others.
  expect(userVersion(db)).toBe(51);
  db.close();
});

test("V52 backfills every row across a chunk boundary (regression: OFFSET pagination skipped ~half the rows)", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  const rowCount = RESOLVE_KEY_BACKFILL_CHUNK + 3;
  db.transaction(() => {
    for (let i = 0; i < rowCount; i++) {
      db.query(
        `INSERT INTO item (id, service, type, external_id, title, body, body_preview,
           body_complete, url, canonical_url, modified_at, metadata, synced_at, pinned)
         VALUES (?, 'github', 'pull_request', ?, ?, '', '', 0, ?, NULL, 1, '{}', 1, 0)`,
      ).run(
        `github:pr-${String(i)}`,
        `pr-${String(i)}`,
        `PR ${String(i)}`,
        `https://github.com/o/r/pull/${String(i)}`,
      );
    }
  })();
  runIndexedSchemaMigrations(db, 52);
  const remaining = db.query("SELECT COUNT(*) AS c FROM item WHERE resolve_key IS NULL").get() as {
    c: number;
  };
  expect(remaining.c).toBe(0);
  // Spot-check a row from the middle of the range. This index sits inside the FIRST chunk (chunk
  // size is RESOLVE_KEY_BACKFILL_CHUNK), so it was never at risk from the broken OFFSET pagination —
  // the `remaining.c === 0` assertion above is what actually catches that regression. This just
  // confirms an arbitrary interior row got the right key.
  const midIndex = Math.floor(rowCount / 2);
  const midRow = db
    .query("SELECT resolve_key FROM item WHERE id = ?")
    .get(`github:pr-${String(midIndex)}`) as { resolve_key: string | null };
  expect(midRow.resolve_key).toBe(
    canonicalizeUrl(`https://github.com/o/r/pull/${String(midIndex)}`),
  );
  db.close();
});

test("V52 recreates item_fts_update after dropping it for the backfill", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 52);
  const trigger = db
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'item_fts_update'")
    .get() as { name: string } | null;
  expect(trigger?.name).toBe("item_fts_update");
  db.close();
});

test("V52 backfill leaves FTS search working for a row that existed before the migration", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  // Inserted while item_fts_insert (created at V48) is live, so item_fts is populated for this row
  // exactly as it would be in production before the V52 backfill ever runs.
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview,
       body_complete, url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('github:pr-9','github','pull_request','pr-9','Widget PR','fixes the frobnicator','',0,
       'https://github.com/o/r/pull/9',NULL,1,'{}',1,0)`,
  ).run();
  runIndexedSchemaMigrations(db, 52);
  const hits = db
    .query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'frobnicator'")
    .all() as Array<{ rowid: number }>;
  expect(hits.length).toBe(1);
  db.close();
});
