// packages/cli/src/lib/restore-db-from-snapshot.test.ts
//
// Phase 6 commit 5 of 14 — covers `restoreDbFromSnapshot`. The helper
// is tiny: read a gzipped SQLite snapshot, decompress, overwrite the
// live DB file. We exercise it against:
//   * a missing snapshot path (Bun.file().readFileSync throws ENOENT)
//   * a real SQLite snapshot built via bun:sqlite + Bun.gzipSync
//   * a corrupted snapshot (garbage bytes -> gunzip throws)

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { restoreDbFromSnapshot } from "./restore-db-from-snapshot.ts";

describe("restoreDbFromSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-restore-db-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when the snapshot path does not exist", () => {
    const missing = join(dir, "does-not-exist.db.gz");
    const target = join(dir, "nimbus.db");
    expect(() => restoreDbFromSnapshot(missing, target)).toThrow();
    // Target file must remain absent so the caller knows nothing was
    // partially written.
    expect(existsSync(target)).toBe(false);
  });

  it("restores a valid gzipped SQLite snapshot to the target path", () => {
    // Build a real SQLite file with a known row, then gzip its bytes.
    const sourcePath = join(dir, "source.db");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");
    source.run("INSERT INTO marker (id, val) VALUES (?, ?)", [42, "phase6-task5"]);
    source.close();

    const raw = readFileSync(sourcePath);
    const gzipped = Bun.gzipSync(raw);
    const snapshot = join(dir, "snapshot.db.gz");
    writeFileSync(snapshot, gzipped);

    const target = join(dir, "restored.db");
    restoreDbFromSnapshot(snapshot, target);

    expect(existsSync(target)).toBe(true);

    // Verify the restored file is a valid SQLite db with our marker row.
    const restored = new Database(target);
    const row = restored
      .query<{ id: number; val: string }, []>("SELECT id, val FROM marker WHERE id = 42")
      .get();
    restored.close();
    expect(row).toEqual({ id: 42, val: "phase6-task5" });
  });

  it("overwrites an existing target file (in-place restore)", () => {
    // Pre-populate the target with junk; restore must replace it.
    const target = join(dir, "live.db");
    writeFileSync(target, Buffer.from("stale bytes"));

    const sourcePath = join(dir, "fresh.db");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
    source.run("INSERT INTO marker (id) VALUES (1)");
    source.close();
    const snapshot = join(dir, "fresh.db.gz");
    writeFileSync(snapshot, Bun.gzipSync(readFileSync(sourcePath)));

    restoreDbFromSnapshot(snapshot, target);

    const restored = new Database(target);
    const row = restored.query<{ id: number }, []>("SELECT id FROM marker").get();
    restored.close();
    expect(row?.id).toBe(1);
  });

  it("throws when the snapshot is corrupted (not a gzip stream)", () => {
    const snapshot = join(dir, "garbage.db.gz");
    writeFileSync(snapshot, Buffer.from("this is not a gzip stream — just plain bytes"));
    const target = join(dir, "should-not-appear.db");
    expect(() => restoreDbFromSnapshot(snapshot, target)).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("throws when the snapshot has a valid gzip header but truncated body", () => {
    // Take a real gzip stream and chop the last bytes off to provoke an
    // unexpected-end-of-input error from gunzip.
    const original = Bun.gzipSync(Buffer.from("hello"));
    const truncated = original.subarray(0, Math.max(1, original.byteLength - 4));
    const snapshot = join(dir, "truncated.db.gz");
    writeFileSync(snapshot, truncated);
    const target = join(dir, "truncated-target.db");
    expect(() => restoreDbFromSnapshot(snapshot, target)).toThrow();
  });
});
