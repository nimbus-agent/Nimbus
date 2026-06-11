import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SNAPSHOT_CONFIG,
  formatSnapshotList,
  listSnapshots,
  previewRestore,
  pruneSnapshots,
  restoreSnapshot,
  type SnapshotEntry,
  startSnapshotScheduler,
  takeSnapshot,
} from "./snapshot.ts";

// Helper: create a minimal in-memory DB with an `item` table
function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY)");
  return db;
}

// Helper: create a real snapshot and return its path
function createSnapshot(db: Database, dataDir: string): string {
  return takeSnapshot(db, dataDir);
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nimbus-snap-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ─── takeSnapshot + listSnapshots (happy path) ───────────────────────────────

describe("takeSnapshot + listSnapshots — happy path", () => {
  test("takeSnapshot produces a .db.gz file that listSnapshots discovers", () => {
    const db = makeDb();
    const gzPath = createSnapshot(db, dataDir);
    db.close();

    expect(gzPath).toMatch(/nimbus-\d+\.db\.gz$/);

    const entries = listSnapshots(dataDir);
    expect(entries).toHaveLength(1);
    const first = entries[0];
    expect(first).toBeDefined();
    expect(first!.path).toBe(gzPath);
    expect(first!.compressedSizeBytes).toBeGreaterThan(0);
    expect(first!.timestampMs).toBeGreaterThan(0);
  });

  test("listSnapshots returns entries sorted newest-first", () => {
    const db = makeDb();
    // Write two fake snapshot files with known timestamps
    const snapshotsDir = join(dataDir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });

    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_001_000;
    // Bun.gzipSync needs actual bytes — use a real compressed copy
    const rawDb = new Database(":memory:");
    rawDb.exec("CREATE TABLE item (id INTEGER)");
    const tmpSnap = join(dataDir, "tmp-for-gz.db");
    rawDb.run(`VACUUM INTO ?`, [tmpSnap]);
    rawDb.close();
    const rawBytes = readFileSync(tmpSnap);
    const gz = Bun.gzipSync(rawBytes);
    rmSync(tmpSnap);

    writeFileSync(join(snapshotsDir, `nimbus-${String(t1)}.db.gz`), gz);
    writeFileSync(join(snapshotsDir, `nimbus-${String(t2)}.db.gz`), gz);
    db.close();

    const entries = listSnapshots(dataDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.timestampMs).toBeGreaterThanOrEqual(entries[1]!.timestampMs);
  });
});

// ─── listSnapshots: non-existent dir → [] ────────────────────────────────────

describe("listSnapshots — non-existent dir", () => {
  test("returns empty array when snapshots dir does not exist", () => {
    const absent = join(dataDir, "no-such-dir");
    const entries = listSnapshots(absent);
    expect(entries).toEqual([]);
  });
});

// ─── listSnapshots line 103: NaN timestamp → skipped (TRUE arm) ──────────────

describe("listSnapshots — line 103 TRUE arm: NaN timestamp skipped", () => {
  test("file named nimbus-NOTANUMBER.db.gz is skipped", () => {
    const snapshotsDir = join(dataDir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });

    // Write a junk file whose timestamp portion is not numeric
    writeFileSync(join(snapshotsDir, "nimbus-NOTANUMBER.db.gz"), "junk");

    const db = makeDb();
    const gzPath = createSnapshot(db, dataDir);
    db.close();

    const entries = listSnapshots(dataDir);
    // The real snapshot should be present; the junk file should be absent
    const names = entries.map((e) => e.filename);
    expect(names.some((n) => n.includes("NOTANUMBER"))).toBe(false);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.path === gzPath)).toBe(true);
  });

  test("file named nimbus-.db.gz (empty digits) is skipped", () => {
    const snapshotsDir = join(dataDir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    // parseInt("") → NaN
    writeFileSync(join(snapshotsDir, "nimbus-.db.gz"), "junk");

    const entries = listSnapshots(dataDir);
    expect(entries).toHaveLength(0);
  });
});

// ─── previewRestore — happy path ─────────────────────────────────────────────

describe("previewRestore — happy path", () => {
  test("returns snapshotItemCount matching what was in the snapshot db", () => {
    const db = makeDb();
    db.run("INSERT INTO item (id) VALUES (1), (2), (3)");
    const gzPath = createSnapshot(db, dataDir);

    const preview = previewRestore(db, gzPath);
    expect(preview.snapshotItemCount).toBe(3);
    expect(preview.currentItemCount).toBe(3);
    expect(preview.snapshotTimestampMs).toBeGreaterThan(0);
    db.close();
  });
});

// ─── previewRestore lines 156/160: regex doesn't match → snapshotTimestampMs=0

describe("previewRestore — line 156 TRUE arm: non-matching filename", () => {
  test("snapshotPath with no matching nimbus-<digits>.db.gz pattern yields snapshotTimestampMs=0", () => {
    // Create a real snapshot and copy to a weird name so gunzip still works
    const db = makeDb();
    const gzPath = createSnapshot(db, dataDir);
    db.close();

    // Copy the valid gz bytes to a path that doesn't match the regex
    const gzBytes = readFileSync(gzPath);
    const weirdPath = join(dataDir, "weird-name.gz");
    writeFileSync(weirdPath, gzBytes);

    const db2 = makeDb();
    const preview = previewRestore(db2, weirdPath);
    db2.close();

    // tsStr becomes "0", parseInt("0")=0 which IS finite, so snapshotTimestampMs=0
    expect(preview.snapshotTimestampMs).toBe(0);
  });
});

// ─── previewRestore lines 142/150: `row?.c ?? 0` defensive arms ──────────────
// These arms guard against the db.query().get() returning `undefined`.
// With real SQLite, COUNT(*) always returns a row with a numeric c — these
// are DEFENSIVE/UNREACHABLE with real sqlite. See D-candidates section below.

// ─── previewRestore line 160 FALSE arm: Number.isFinite(tsMs) = false ────────
// When the regex matches (snapshotTsMatch?.[1] is a digit string), parseInt
// always returns a finite number (JS digits never overflow to NaN). The only
// path to the FALSE arm is regex-no-match → tsStr="0" → parseInt("0")=0 which
// IS finite. Thus the FALSE arm of line 160 is DEFENSIVE/UNREACHABLE with any
// realistic input (see D-candidates).

// ─── restoreSnapshot ─────────────────────────────────────────────────────────

describe("restoreSnapshot", () => {
  test("overwrites the target db file with snapshot contents", () => {
    const db = makeDb();
    db.run("INSERT INTO item (id) VALUES (42)");
    const gzPath = createSnapshot(db, dataDir);
    db.close();

    const targetPath = join(dataDir, "restored.db");
    restoreSnapshot(gzPath, targetPath);

    const restored = new Database(targetPath, { readonly: true });
    const row = restored.query("SELECT COUNT(*) as c FROM item").get() as { c: number };
    expect(row.c).toBe(1);
    restored.close();
  });
});

// ─── pruneSnapshots ──────────────────────────────────────────────────────────

describe("pruneSnapshots", () => {
  test("deletes oldest snapshots beyond keepLast and returns deleted count", () => {
    // Create 3 snapshots with distinct timestamps via fabricated files
    const snapshotsDir = join(dataDir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });

    // Build a minimal gz to put in each fabricated snapshot file
    const rawDb = new Database(":memory:");
    rawDb.exec("CREATE TABLE item (id INTEGER)");
    const tmpPath = join(dataDir, "tmpraw.db");
    rawDb.run(`VACUUM INTO ?`, [tmpPath]);
    rawDb.close();
    const rawBytes = readFileSync(tmpPath);
    const gz = Bun.gzipSync(rawBytes);
    rmSync(tmpPath);

    const t1 = 1_700_000_001_000;
    const t2 = 1_700_000_002_000;
    const t3 = 1_700_000_003_000;
    writeFileSync(join(snapshotsDir, `nimbus-${String(t1)}.db.gz`), gz);
    writeFileSync(join(snapshotsDir, `nimbus-${String(t2)}.db.gz`), gz);
    writeFileSync(join(snapshotsDir, `nimbus-${String(t3)}.db.gz`), gz);

    const deleted = pruneSnapshots(dataDir, 2);
    expect(deleted).toBe(1);

    const remaining = listSnapshots(dataDir);
    expect(remaining).toHaveLength(2);
    // The remaining entries should be the two newest (t3, t2)
    const remainTs = remaining.map((e) => e.timestampMs).sort((a, b) => b - a);
    expect(remainTs[0]).toBe(t3);
    expect(remainTs[1]).toBe(t2);
  });

  test("pruneSnapshots with keepLast >= total count deletes nothing", () => {
    const db = makeDb();
    createSnapshot(db, dataDir);
    db.close();

    const deleted = pruneSnapshots(dataDir, 10);
    expect(deleted).toBe(0);
    expect(listSnapshots(dataDir)).toHaveLength(1);
  });

  test("pruneSnapshots on non-existent dir returns 0", () => {
    const absent = join(dataDir, "no-snapshots-here");
    const deleted = pruneSnapshots(absent, 3);
    expect(deleted).toBe(0);
  });
});

// ─── startSnapshotScheduler ──────────────────────────────────────────────────

describe("startSnapshotScheduler — enabled:false early return (line 200)", () => {
  test("returns a no-op handle when config.enabled is false", () => {
    const db = makeDb();
    const config = { ...DEFAULT_SNAPSHOT_CONFIG, enabled: false };
    const handle = startSnapshotScheduler(db, dataDir, config, false);

    // stop() must not throw
    expect(() => handle.stop()).not.toThrow();

    // No snapshot should have been taken
    expect(listSnapshots(dataDir)).toHaveLength(0);
    db.close();
  });
});

describe("startSnapshotScheduler — runNow:true creates a snapshot immediately", () => {
  test("runNow=true takes a snapshot before returning the handle", () => {
    const db = makeDb();
    const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 999_999_999 };
    const handle = startSnapshotScheduler(db, dataDir, config, true);

    const entries = listSnapshots(dataDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    handle.stop();
    db.close();
  });
});

describe("startSnapshotScheduler — enabled:true, runNow:false", () => {
  test("returns a stoppable handle without immediately taking a snapshot", () => {
    const db = makeDb();
    const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 999_999_999 };
    const handle = startSnapshotScheduler(db, dataDir, config, false);

    // No snapshot yet (interval hasn't fired)
    expect(listSnapshots(dataDir)).toHaveLength(0);
    handle.stop();
    db.close();
  });
});

// ─── formatSnapshotList ───────────────────────────────────────────────────────

describe("formatSnapshotList — empty list", () => {
  test("returns 'No snapshots found.' for empty input", () => {
    expect(formatSnapshotList([])).toBe("No snapshots found.");
  });
});

describe("formatSnapshotList — humanBytes tiers (lines 229–232)", () => {
  function entry(compressedSizeBytes: number): SnapshotEntry {
    return {
      path: join("snapshots", `nimbus-1700000000000.db.gz`),
      filename: "nimbus-1700000000000.db.gz",
      timestampMs: 1_700_000_000_000,
      compressedSizeBytes,
    };
  }

  test("< 1024 bytes → output contains 'B' (not KB/MB/GB)", () => {
    const out = formatSnapshotList([entry(500)]);
    expect(out).toContain(" B");
    expect(out).not.toContain("KB");
    expect(out).not.toContain("MB");
    expect(out).not.toContain("GB");
  });

  test("1024–1048575 bytes → output contains 'KB'", () => {
    const out = formatSnapshotList([entry(2048)]);
    expect(out).toContain("KB");
    expect(out).not.toContain("MB");
    expect(out).not.toContain("GB");
  });

  test("1048576–1073741823 bytes → output contains 'MB'", () => {
    const out = formatSnapshotList([entry(5 * 1024 * 1024)]);
    expect(out).toContain("MB");
    expect(out).not.toContain("GB");
  });

  test(">= 1073741824 bytes → output contains 'GB'", () => {
    const out = formatSnapshotList([entry(3 * 1024 * 1024 * 1024)]);
    expect(out).toContain("GB");
  });

  test("non-empty list includes header and separator row", () => {
    const out = formatSnapshotList([entry(512)]);
    expect(out).toContain("FILENAME");
    expect(out).toContain("TIMESTAMP");
    expect(out).toContain("SIZE");
    expect(out).toContain("─");
  });
});

// ─── DEFAULT_SNAPSHOT_CONFIG ──────────────────────────────────────────────────

describe("DEFAULT_SNAPSHOT_CONFIG", () => {
  test("has expected default values", () => {
    expect(DEFAULT_SNAPSHOT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_SNAPSHOT_CONFIG.keepLast).toBe(7);
    expect(DEFAULT_SNAPSHOT_CONFIG.intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});

/*
 * D-CANDIDATES (DEFENSIVE / UNREACHABLE branches — NOT tested)
 *
 * line 142 — `row?.c ?? 0` (snapCount fallback in previewRestore):
 *   BunDatabase.query("SELECT COUNT(*) as c …").get() always returns a row
 *   object with a numeric `c` when the table exists. The `undefined` branch
 *   is a TypeScript-safety cast artifact; no runtime path reaches it.
 *
 * line 150 — `row?.c ?? 0` (liveCount fallback in previewRestore):
 *   Same reasoning as line 142 — COUNT(*) on a real SQLite table is never null.
 *   The missing-table case is caught by the surrounding try/catch (liveCount
 *   stays 0 from the `let` initialisation, not from `?? 0`).
 *
 * line 160 — `Number.isFinite(tsMs) ? tsMs : 0` FALSE arm (tsMs non-finite):
 *   `tsStr` is either the regex-captured digit string (parseInt → always finite
 *   for JS digit strings) or the literal "0" when the regex doesn't match
 *   (parseInt("0") = 0, which is finite). There is no realistic input that
 *   reaches this arm; it is a belt-and-suspenders guard.
 */
