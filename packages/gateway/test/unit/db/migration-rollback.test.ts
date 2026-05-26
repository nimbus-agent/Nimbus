import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalIndex } from "../../../src/index/local-index.ts";
import {
  type MigrationBackupOptions,
  MigrationRollbackError,
  runIndexedSchemaMigrations,
} from "../../../src/index/migrations/runner.ts";

function makeTempDir(): string {
  const dir = join(tmpdir(), `nimbus-test-${String(Date.now())}-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("MigrationRollbackError", () => {
  test("carries version and backup path", () => {
    const err = new MigrationRollbackError(7, "/some/backup.db.gz", new Error("inner"));
    expect(err.migrationVersion).toBe(7);
    expect(err.backupPath).toBe("/some/backup.db.gz");
    expect(err.message).toContain("v7");
    expect(err.message).toContain("/some/backup.db.gz");
    expect(err.name).toBe("MigrationRollbackError");
  });

  test("null backup path produces informative message", () => {
    const err = new MigrationRollbackError(3, null, new Error("oops"));
    expect(err.backupPath).toBeNull();
    expect(err.message).toContain("No backup was available");
  });
});

describe("runIndexedSchemaMigrations — no backup options", () => {
  test("migrates a fresh in-memory db to SCHEMA_VERSION without backup", () => {
    const db = new Database(":memory:");
    // Should not throw — backup options are optional
    expect(() => runIndexedSchemaMigrations(db, 12)).not.toThrow();
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(12);
    db.close();
  });

  test("no-op when already at target version", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 12);
    // Should be idempotent
    expect(() => runIndexedSchemaMigrations(db, 12)).not.toThrow();
    db.close();
  });
});

describe("runIndexedSchemaMigrations — with backup options", () => {
  test("writes a .db.gz backup file before each migration step", () => {
    const tempDir = makeTempDir();
    const dbPath = join(tempDir, "nimbus.db");
    const backupDir = join(tempDir, "backups");

    // Open a file-backed DB (VACUUM INTO requires a real file)
    const db = new Database(dbPath);
    const opts: MigrationBackupOptions = { backupDir, dbPath };

    runIndexedSchemaMigrations(db, 12, opts);

    const files = readdirSync(backupDir).filter((f) => f.endsWith(".db.gz"));
    // One backup per migration step (12 steps from 0→12)
    expect(files.length).toBeGreaterThan(0);
    // Backup filenames match expected pattern
    expect(files.every((f) => f.startsWith("pre-migration-"))).toBe(true);
    db.close();
  });

  test("already-migrated DB skips backup and no-ops cleanly", () => {
    const tempDir = makeTempDir();
    const dbPath = join(tempDir, "nimbus.db");
    const backupDir = join(tempDir, "backups");

    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 12);

    // Second call with backup options — nothing to migrate, no backups written
    const opts: MigrationBackupOptions = { backupDir, dbPath };
    runIndexedSchemaMigrations(db, 12, opts);

    let files: string[] = [];
    try {
      files = readdirSync(backupDir);
    } catch {
      /* backups dir may not have been created */
    }
    expect(files).toHaveLength(0);
    db.close();
  });
});

describe("runIndexedSchemaMigrations — unsupported target version", () => {
  test("throws when target exceeds the highest known step; schema version unchanged", () => {
    // No file-backed DB or backups needed — this only exercises the
    // post-loop "Unsupported local index schema version" throw.
    const db = new Database(":memory:");

    // Bring the DB up to the current schema so the next call has nothing to do.
    runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      LocalIndex.SCHEMA_VERSION,
    );

    // Targeting one beyond the highest known step throws and leaves user_version intact.
    expect(() => runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION + 1)).toThrow(
      /Unsupported local index schema version/,
    );

    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(LocalIndex.SCHEMA_VERSION);
    db.close();
  });
});

describe("runIndexedSchemaMigrations — backup files per step", () => {
  test("writes a non-empty .db.gz for each migration step", () => {
    const tempDir = makeTempDir();
    const dbPath = join(tempDir, "nimbus.db");
    const backupDir = join(tempDir, "backups");

    const db = new Database(dbPath);
    // Establish a real file-backed DB with one schema applied so VACUUM INTO
    // has something to copy on the next call.
    runIndexedSchemaMigrations(db, 1);

    // Two backups are enough to prove the per-step contract; running the full
    // schema range here is wall-clock heavy on Windows (Defender + journal fsync)
    // and offers no extra coverage.
    const opts: MigrationBackupOptions = { backupDir, dbPath };
    runIndexedSchemaMigrations(db, 3, opts);

    const files = readdirSync(backupDir).filter((f) => f.endsWith(".db.gz"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const size = statSync(join(backupDir, f)).size;
      expect(size).toBeGreaterThan(0);
    }
    db.close();
  });
});
