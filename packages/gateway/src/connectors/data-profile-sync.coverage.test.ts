/**
 * The two data-profile paths `data-profile-sync.test.ts` records as unreachable "D-candidates":
 * files over the 64 MiB text cap, and a file the OS refuses to open.
 *
 * The cap is reachable cheaply after all: a SPARSE file — a few real header bytes, then
 * `truncate` past the cap — reports the large size without 64 MiB ever being written, on NTFS,
 * ext4 and APFS alike, in well under a millisecond. The reader only ever touches the first 64 KiB.
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
import { createDataProfileSyncable } from "./data-profile-sync.ts";

/** One byte past `MAX_TEXT_BYTES` in data-profile-sync.ts: the smallest size that is peeked. */
const OVER_TEXT_CAP = 64 * 1024 * 1024 + 1;

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-dp-cov-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real header bytes, then a sparse extension to `size`. */
function sparseFile(path: string, head: string, size: number): void {
  writeFileSync(path, head);
  truncateSync(path, size);
}

async function syncDir(dir: string): Promise<{ upserted: number; db: Database }> {
  const db = createMemoryIndexDb();
  const sync = createDataProfileSyncable({
    ensureDataprofileMcpRunning: async () => {},
    readParquetMetadata: async () => null,
  });
  const r = await sync.sync(
    syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
    null,
  );
  return { upserted: r.itemsUpserted, db };
}

type ProfileMeta = {
  relativePath: string;
  columns: { name: string; type: string | null }[];
  rowCountEstimate: number | null;
  sizeBytes: number;
};

function profiles(db: Database): ProfileMeta[] {
  return (
    db
      .query("SELECT metadata FROM item WHERE service = 'dataprofile' ORDER BY external_id")
      .all() as { metadata: string }[]
  )
    .map((r) => JSON.parse(r.metadata) as ProfileMeta)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

describe("files over the 64 MiB text cap", () => {
  test("csv and jsonl are profiled from a header-only peek with no row estimate; json is skipped", async () => {
    const dir = tempRoot();
    sparseFile(join(dir, "big.csv"), "id,name,score\n1,alpha,2\n", OVER_TEXT_CAP);
    sparseFile(join(dir, "big.jsonl"), '{"k":1,"s":"x"}\n{"k":2,"s":"y"}\n', OVER_TEXT_CAP);
    // A complete array padded with whitespace PAST the 64 KiB peek: the peek alone parses as
    // valid JSON, so only the "truncated → skip" rule keeps a profile of a document that was
    // never read in full out of the index.
    sparseFile(join(dir, "big.json"), `[{"a":1}]${" ".repeat(70_000)}`, OVER_TEXT_CAP);
    // Control under the cap: read whole, so it DOES get a row estimate.
    writeFileSync(join(dir, "small.csv"), "x,y\n1,2\n");

    const { upserted, db } = await syncDir(dir);
    const got = profiles(db);
    db.close();

    // big.json is NOT here: a JSON document over the cap is never profiled from a partial read.
    expect(upserted).toBe(3);
    expect(got.map((p) => p.relativePath)).toEqual(["big.csv", "big.jsonl", "small.csv"]);
    const [bigCsv, bigJsonl, smallCsv] = got;
    expect(bigCsv?.columns).toEqual([
      { name: "id", type: null },
      { name: "name", type: null },
      { name: "score", type: null },
    ]);
    expect(bigCsv?.rowCountEstimate).toBeNull();
    expect(bigCsv?.sizeBytes).toBe(OVER_TEXT_CAP);
    expect(bigJsonl?.columns).toEqual([
      { name: "k", type: "number" },
      { name: "s", type: "string" },
    ]);
    expect(bigJsonl?.rowCountEstimate).toBeNull();
    expect(smallCsv?.rowCountEstimate).toBe(1);
  });
});

describe("a file the OS refuses to open", () => {
  test("is skipped while the readable files beside it are still profiled", async () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "ok.csv"), "a,b\n1,2\n");
    const locked = join(dir, "locked.csv");
    writeFileSync(locked, "secret,cols\n1,2\n");
    chmodSync(locked, 0o000);
    try {
      // SELF-VALIDATING: mode bits refuse an open only on POSIX for a non-root user. On Windows
      // or as root the file is simply readable, and both files are profiled.
      let openRefused = false;
      try {
        closeSync(openSync(locked, "r"));
      } catch {
        openRefused = true;
      }

      const { upserted, db } = await syncDir(dir);
      const paths = profiles(db).map((p) => p.relativePath);
      db.close();

      if (openRefused) {
        expect(upserted).toBe(1);
        expect(paths).toEqual(["ok.csv"]);
      } else {
        expect(upserted).toBe(2);
        expect(paths).toEqual(["locked.csv", "ok.csv"]);
      }
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});
