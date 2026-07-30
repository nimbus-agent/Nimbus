import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SNAPSHOT_CONFIG,
  formatSnapshotList,
  listSnapshots,
  previewRestore,
  pruneSnapshots,
  restoreSnapshot,
  startSnapshotScheduler,
  takeSnapshot,
} from "../../../src/db/snapshot.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

function makeDbAt(dbPath: string): Database {
  const db = new Database(dbPath);
  LocalIndex.ensureSchema(db);
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:1','github','pr','1','seed-a',0,0)`,
  );
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:2','github','pr','2','seed-b',0,0)`,
  );
  return db;
}

describe("db/snapshot", () => {
  let tmp: string;
  let dbPath: string;
  let dataDir: string;
  let db: Database;
  let templateDir: string;
  let templateDbPath: string;

  /**
   * Running every migration against a fresh SQLite file cost ~232 ms per test
   * on Windows — ~2,000x the per-test cleanup and the dominant term behind the
   * 30 s hook-timeout flake in #968. Migrating once into a template and copying
   * the file per test is measured 16.6x faster end-to-end (231.8 ms -> 6.1 ms
   * per test) and yields an identical database: same `user_version`, same 69
   * tables, same seed rows.
   *
   * `ensureSchema` still runs on each copy — on an already-current
   * `user_version` it skips every migration and only applies the
   * connection-level pragmas, which do not survive in the file.
   */
  beforeAll(() => {
    templateDir = mkdtempSync(join(tmpdir(), "nimbus-snapshot-template-"));
    templateDbPath = join(templateDir, "template.db");
    makeDbAt(templateDbPath).close();
  });

  afterAll(() => {
    rmSync(templateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-snapshot-test-"));
    dbPath = join(tmp, "nimbus.db");
    dataDir = tmp;
    copyFileSync(templateDbPath, dbPath);
    db = new Database(dbPath);
    LocalIndex.ensureSchema(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* the restoreSnapshot cases close and reopen `db` themselves */
    }
    // Cleanup is expected to succeed on every platform. It used to fail EBUSY
    // 30/30 on Windows because an unfinalized prepared statement kept the
    // database file open (#969, fixed in migrations/runner.ts); the error was
    // swallowed here, so every run silently leaked a temp directory. Do not
    // re-add a catch: a failure here now means a handle is being retained again.
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("takeSnapshot", () => {
    it("creates a .db.gz file in <dataDir>/snapshots/", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      expect(existsSync(snapshotPath)).toBe(true);
    });

    it("filename matches nimbus-<timestamp>.db.gz", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      const filename = snapshotPath.split(/[/\\]/).pop() ?? "";
      expect(filename).toMatch(/^nimbus-\d+\.db\.gz$/);
    });

    it("compressed file is non-empty and has gzip magic bytes (0x1f 0x8b)", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      const buf = readFileSync(snapshotPath);
      expect(buf.byteLength).toBeGreaterThan(0);
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });

    it("snapshot is decompressible and contains a valid SQLite database", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      const compressed = readFileSync(snapshotPath);
      const raw = Bun.gunzipSync(compressed);
      const magic = String.fromCodePoint(...raw.slice(0, 15));
      expect(magic).toBe("SQLite format 3");
    });
  });

  describe("listSnapshots", () => {
    it("returns empty array when snapshots dir does not exist", () => {
      const entries = listSnapshots(dataDir);
      expect(entries).toEqual([]);
    });

    it("returns one entry after one snapshot is taken", () => {
      takeSnapshot(db, dataDir);
      const entries = listSnapshots(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.filename).toMatch(/^nimbus-\d+\.db\.gz$/);
      expect(entries[0]?.compressedSizeBytes).toBeGreaterThan(0);
    });

    it("returns entries newest-first when multiple snapshots exist", async () => {
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);

      const entries = listSnapshots(dataDir);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.timestampMs).toBeGreaterThanOrEqual(entries[1]!.timestampMs);
    });

    it("ignores files that do not match the nimbus-<ts>.db.gz pattern", () => {
      const snapshotsDir = join(dataDir, "snapshots");
      takeSnapshot(db, dataDir);
      writeFileSync(join(snapshotsDir, "unrelated.txt"), "garbage");
      writeFileSync(join(snapshotsDir, "backup.db"), "not a snapshot");

      const entries = listSnapshots(dataDir);
      expect(entries).toHaveLength(1);
      for (const e of entries) {
        expect(e.filename).toMatch(/^nimbus-\d+\.db\.gz$/);
      }
    });

    it("populates path, filename, timestampMs, and compressedSizeBytes fields", () => {
      takeSnapshot(db, dataDir);
      const [entry] = listSnapshots(dataDir);
      expect(typeof entry?.path).toBe("string");
      expect(typeof entry?.filename).toBe("string");
      expect(typeof entry?.timestampMs).toBe("number");
      expect(Number.isFinite(entry?.timestampMs)).toBe(true);
      expect(typeof entry?.compressedSizeBytes).toBe("number");
    });
  });

  describe("previewRestore", () => {
    it("reports snapshotItemCount matching items in snapshot", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      const preview = previewRestore(db, snapshotPath);
      expect(preview.snapshotItemCount).toBe(2);
    });

    it("reports currentItemCount matching live DB", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      const preview = previewRestore(db, snapshotPath);
      expect(preview.currentItemCount).toBe(2);
    });

    it("does NOT mutate the live DB row count", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      previewRestore(db, snapshotPath);
      const row = db.query("SELECT COUNT(*) AS c FROM item").get() as { c: number };
      expect(row.c).toBe(2);
    });

    it("reports currentItemCount 0 when the live DB has no item table yet", () => {
      const snapshotPath = takeSnapshot(db, dataDir);

      // The live-count read is wrapped in `catch { /* item table may not exist yet */ }`.
      // That arm is reached with a database that has never been migrated — the real case
      // being a restore attempted against a freshly created, schema-less file.
      const bare = new Database(join(tmp, "bare.db"));
      try {
        const preview = previewRestore(bare, snapshotPath);
        expect(preview.currentItemCount).toBe(0);
        // The snapshot side still reads normally — only the live read degraded.
        expect(preview.snapshotItemCount).toBe(2);
      } finally {
        bare.close();
      }
    });

    it("extracts snapshotTimestampMs from the filename", () => {
      const before = Date.now();
      const snapshotPath = takeSnapshot(db, dataDir);
      const preview = previewRestore(db, snapshotPath);
      expect(preview.snapshotTimestampMs).toBeGreaterThanOrEqual(before);
      expect(preview.snapshotTimestampMs).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("restoreSnapshot", () => {
    it("overwrites the live DB file so row count matches the snapshot", () => {
      const snapshotPath = takeSnapshot(db, dataDir);

      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
         VALUES ('github:3','github','pr','3','extra',0,0)`,
      );
      db.close();

      restoreSnapshot(snapshotPath, dbPath);

      const restored = new Database(dbPath, { readonly: true });
      const row = restored.query("SELECT COUNT(*) AS c FROM item").get() as { c: number };
      restored.close();

      db = new Database(dbPath);

      expect(row.c).toBe(2);
    });

    it("resulting file is a valid SQLite database (readable after restore)", () => {
      const snapshotPath = takeSnapshot(db, dataDir);
      db.close();
      restoreSnapshot(snapshotPath, dbPath);
      const reopened = new Database(dbPath);
      const row = reopened.query("SELECT COUNT(*) AS c FROM item").get() as { c: number };
      reopened.close();
      db = new Database(dbPath);
      expect(typeof row.c).toBe("number");
    });
  });

  describe("pruneSnapshots", () => {
    it("returns 0 when there are no snapshots", () => {
      const deleted = pruneSnapshots(dataDir, 3);
      expect(deleted).toBe(0);
    });

    it("keeps all snapshots when keepLast >= total count", async () => {
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);

      const deleted = pruneSnapshots(dataDir, 5);
      expect(deleted).toBe(0);
      expect(listSnapshots(dataDir)).toHaveLength(2);
    });

    it("deletes oldest snapshots so exactly keepLast remain", async () => {
      for (let i = 0; i < 5; i++) {
        takeSnapshot(db, dataDir);
        if (i < 4) await Bun.sleep(5);
      }
      expect(listSnapshots(dataDir)).toHaveLength(5);

      const deleted = pruneSnapshots(dataDir, 2);
      expect(deleted).toBe(3);
      expect(listSnapshots(dataDir)).toHaveLength(2);
    });

    it("physically removes deleted snapshot files from disk", async () => {
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);

      const allBefore = listSnapshots(dataDir);
      expect(allBefore).toHaveLength(3);

      pruneSnapshots(dataDir, 1);

      const toBeDeleted = allBefore.slice(1);
      for (const e of toBeDeleted) {
        expect(existsSync(e.path)).toBe(false);
      }
    });

    it("counts only what it actually deleted when an entry cannot be removed", async () => {
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);

      // `pruneSnapshots` deletes with a bare `rmSync(path)` inside a best-effort
      // try/catch. A DIRECTORY whose name matches the snapshot pattern is listed by
      // `listSnapshots` (it only pattern-matches the name and stats the path) but
      // `rmSync` without `recursive` refuses to remove it on every platform — so this
      // exercises the catch arm without depending on file locking or a race.
      const undeletable = join(dataDir, "snapshots", "nimbus-9999999999999.db.gz");
      mkdirSync(undeletable);

      expect(listSnapshots(dataDir)).toHaveLength(3);

      // keepLast=0 → all three are candidates, but only the two real files go.
      const deleted = pruneSnapshots(dataDir, 0);
      expect(deleted).toBe(2);

      // The directory survives and is still listed: prune degrades, it does not throw.
      const remaining = listSnapshots(dataDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.filename).toBe("nimbus-9999999999999.db.gz");

      rmSync(undeletable, { recursive: true, force: true });
    });

    it("keeps exactly keepLast=1 (newest)", async () => {
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);

      const beforeList = listSnapshots(dataDir);
      const newestPath = beforeList[0]!.path;

      pruneSnapshots(dataDir, 1);

      const remaining = listSnapshots(dataDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.path).toBe(newestPath);
    });
  });

  describe("startSnapshotScheduler", () => {
    it("returns a handle with a stop() method", () => {
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 100_000 };
      const handle = startSnapshotScheduler(db, dataDir, config, false);
      expect(typeof handle.stop).toBe("function");
      handle.stop();
    });

    it("fires immediately when runNow=true", () => {
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 100_000 };
      const handle = startSnapshotScheduler(db, dataDir, config, true);
      handle.stop();
      expect(listSnapshots(dataDir).length).toBeGreaterThanOrEqual(1);
    });

    it("does NOT fire when runNow=false (before interval elapses)", () => {
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 100_000 };
      const handle = startSnapshotScheduler(db, dataDir, config, false);
      handle.stop();
      expect(listSnapshots(dataDir)).toHaveLength(0);
    });

    it("fires on interval and stop() prevents further fires", async () => {
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 50 };
      const handle = startSnapshotScheduler(db, dataDir, config, false);

      await Bun.sleep(300);
      handle.stop();

      const countAfterStop = listSnapshots(dataDir).length;
      expect(countAfterStop).toBeGreaterThanOrEqual(1);

      await Bun.sleep(100);
      expect(listSnapshots(dataDir)).toHaveLength(countAfterStop);
    });

    it("defaults runNow to false when the argument is omitted", () => {
      // `runNow = false` is a default parameter; every other case here passes it
      // explicitly, so the default arm was never taken. Omitting it must behave like
      // passing false — i.e. no snapshot before the first interval elapses.
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, intervalMs: 100_000 };
      const handle = startSnapshotScheduler(db, dataDir, config);
      handle.stop();
      expect(listSnapshots(dataDir)).toHaveLength(0);
    });

    it("stop() on a disabled scheduler does nothing (no throw)", () => {
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, enabled: false };
      const handle = startSnapshotScheduler(db, dataDir, config, false);
      expect(() => handle.stop()).not.toThrow();
    });

    it("disabled scheduler never creates snapshots", async () => {
      const config = { ...DEFAULT_SNAPSHOT_CONFIG, enabled: false, intervalMs: 5 };
      const handle = startSnapshotScheduler(db, dataDir, config, true);
      await Bun.sleep(20);
      handle.stop();
      expect(listSnapshots(dataDir)).toHaveLength(0);
    });
  });

  describe("formatSnapshotList", () => {
    it("returns a 'No snapshots' message for empty input", () => {
      const output = formatSnapshotList([]);
      expect(output).toMatch(/no snapshots/i);
    });

    it("contains filenames for each entry", () => {
      takeSnapshot(db, dataDir);
      const entries = listSnapshots(dataDir);
      const output = formatSnapshotList(entries);
      for (const e of entries) {
        expect(output).toContain(e.filename);
      }
    });

    it.each(["FILENAME", "TIMESTAMP", "SIZE"])("includes a %s column header", (header) => {
      takeSnapshot(db, dataDir);
      const entries = listSnapshots(dataDir);
      expect(formatSnapshotList(entries)).toContain(header);
    });

    it("formats multiple entries as separate lines", async () => {
      takeSnapshot(db, dataDir);
      await Bun.sleep(5);
      takeSnapshot(db, dataDir);
      const entries = listSnapshots(dataDir);
      const output = formatSnapshotList(entries);
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("DEFAULT_SNAPSHOT_CONFIG", () => {
    it("is enabled by default", () => {
      expect(DEFAULT_SNAPSHOT_CONFIG.enabled).toBe(true);
    });

    it("has a positive intervalMs", () => {
      expect(DEFAULT_SNAPSHOT_CONFIG.intervalMs).toBeGreaterThan(0);
    });

    it("keeps at least 1 snapshot (keepLast >= 1)", () => {
      expect(DEFAULT_SNAPSHOT_CONFIG.keepLast).toBeGreaterThanOrEqual(1);
    });

    it("has a non-empty schedule string", () => {
      expect(typeof DEFAULT_SNAPSHOT_CONFIG.schedule).toBe("string");
      expect(DEFAULT_SNAPSHOT_CONFIG.schedule.length).toBeGreaterThan(0);
    });
  });
});
