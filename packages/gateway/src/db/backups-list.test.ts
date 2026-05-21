import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrationBackups } from "./backups-list.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-backups-"));
}

describe("listMigrationBackups", () => {
  test("returns empty array when backups dir does not exist", () => {
    const dataDir = tmp();
    // dataDir exists but has no "backups" subdirectory
    const result = listMigrationBackups(dataDir);
    expect(result).toEqual([]);
  });

  test("returns empty array when backups dir is empty", () => {
    const dataDir = tmp();
    mkdirSync(join(dataDir, "backups"));
    const result = listMigrationBackups(dataDir);
    expect(result).toEqual([]);
  });

  test("returns entries sorted by mtimeMs descending", () => {
    const dataDir = tmp();
    const backupsDir = join(dataDir, "backups");
    mkdirSync(backupsDir);

    // Create two valid backup files
    const older = join(backupsDir, "pre-migration-V28-older.db.gz");
    const newer = join(backupsDir, "pre-migration-V29-newer.db.gz");
    writeFileSync(older, "older-content");
    writeFileSync(newer, "newer-content");

    // Set explicit mtime values at least 10 ms apart to avoid races
    const olderMtime = new Date(1700000000000);
    const newerMtime = new Date(1700000001000);
    utimesSync(older, olderMtime, olderMtime);
    utimesSync(newer, newerMtime, newerMtime);

    const result = listMigrationBackups(dataDir);

    expect(result).toHaveLength(2);
    // Sorted descending by mtimeMs: newer first
    expect(result[0]?.filename).toBe("pre-migration-V29-newer.db.gz");
    expect(result[1]?.filename).toBe("pre-migration-V28-older.db.gz");
    expect(result[0]?.mtimeMs ?? 0).toBeGreaterThan(result[1]?.mtimeMs ?? 0);
  });

  test("ignores malformed filenames that do not match expected prefix and suffix", () => {
    const dataDir = tmp();
    const backupsDir = join(dataDir, "backups");
    mkdirSync(backupsDir);

    // Valid backup
    const valid = join(backupsDir, "pre-migration-V30-valid.db.gz");
    writeFileSync(valid, "valid");
    utimesSync(valid, new Date(1700000002000), new Date(1700000002000));

    // Malformed: correct suffix but wrong prefix
    writeFileSync(join(backupsDir, "snapshot-V30.db.gz"), "bad-prefix");

    // Malformed: correct prefix but wrong suffix
    writeFileSync(join(backupsDir, "pre-migration-V30-noext.db"), "bad-suffix");

    // Malformed: neither prefix nor suffix
    writeFileSync(join(backupsDir, "random.txt"), "random");

    const result = listMigrationBackups(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("pre-migration-V30-valid.db.gz");
  });

  test("returns compressedSizeBytes matching actual file size", () => {
    const dataDir = tmp();
    const backupsDir = join(dataDir, "backups");
    mkdirSync(backupsDir);

    const content = "some-compressed-data";
    const filePath = join(backupsDir, "pre-migration-V31-size.db.gz");
    writeFileSync(filePath, content);
    utimesSync(filePath, new Date(1700000003000), new Date(1700000003000));

    const result = listMigrationBackups(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.compressedSizeBytes).toBe(Buffer.byteLength(content, "utf8"));
  });
});
