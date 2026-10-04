/**
 * The two skip paths of the local-DB script indexer that `test/unit/connectors/localdb-sync.test.ts`
 * does not reach: a file over the 2 MiB cap, and a file the OS refuses to read.
 *
 * The cap is exercised with SPARSE files — a few real bytes, then `truncate` — so no test writes
 * megabytes to disk.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createLocaldbSyncable } from "./localdb-sync.ts";

/** `MAX_FILE_BYTES` in localdb-sync.ts. */
const CAP = 2 * 1024 * 1024;

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-localdb-cov-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function syncDir(dir: string): Promise<{ upserted: number; paths: string[]; db: Database }> {
  const db = createMemoryIndexDb();
  const r = await createLocaldbSyncable({ ensureLocaldbMcpRunning: async () => {} }).sync(
    syncTestContext(db, createStubVault({ "localdb.scripts_dir": dir }), "localdb"),
    null,
  );
  const paths = (
    db.query("SELECT metadata FROM item WHERE service = 'localdb'").all() as { metadata: string }[]
  )
    .map((x) => (JSON.parse(x.metadata) as { relativePath: string }).relativePath)
    .sort();
  return { upserted: r.itemsUpserted, paths, db };
}

describe("the 2 MiB per-file cap", () => {
  test("a file one byte over the cap is skipped; one exactly at the cap is indexed", async () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "at-cap.sql"), "select 1;\n");
    truncateSync(join(dir, "at-cap.sql"), CAP);
    writeFileSync(join(dir, "over-cap.sql"), "select 2;\n");
    truncateSync(join(dir, "over-cap.sql"), CAP + 1);
    writeFileSync(join(dir, "small.sql"), "select * from users;\n");

    const { upserted, paths, db } = await syncDir(dir);
    db.close();

    expect(upserted).toBe(2);
    expect(paths).toEqual(["at-cap.sql", "small.sql"]);
  });
});

describe("a file the OS refuses to read", () => {
  test("is skipped while the readable scripts beside it are still indexed", async () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "ok.sql"), "select 1;\n");
    const locked = join(dir, "locked.sql");
    writeFileSync(locked, "select secret from vault;\n");
    chmodSync(locked, 0o000);
    try {
      // SELF-VALIDATING: mode bits refuse a read only on POSIX for a non-root user.
      let readRefused = false;
      try {
        closeSync(openSync(locked, "r"));
      } catch {
        readRefused = true;
      }

      const { upserted, paths, db } = await syncDir(dir);
      db.close();

      if (readRefused) {
        expect(upserted).toBe(1);
        expect(paths).toEqual(["ok.sql"]);
      } else {
        expect(upserted).toBe(2);
        expect(paths).toEqual(["locked.sql", "ok.sql"]);
      }
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});
