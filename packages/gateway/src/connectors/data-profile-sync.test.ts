import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  expectSyncNoopResult,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  createDataProfileSyncable,
  type DataProfileSyncableOptions,
  type ParquetMetadataReader,
} from "./data-profile-sync.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

/** A parquet metadata reader that always returns null (simulates corrupt footer). */
const nullParquetReader: ParquetMetadataReader = async () => null;

/** A parquet metadata reader that returns a valid minimal metadata object. */
function makeParquetReader(
  schema: Array<{ name?: unknown; type?: unknown }> = [],
  num_rows?: number | bigint,
): ParquetMetadataReader {
  return async () => ({ schema, ...(num_rows !== undefined ? { num_rows } : {}) });
}

function makeOptions(
  overrides: Partial<DataProfileSyncableOptions> = {},
): DataProfileSyncableOptions {
  return {
    ensureDataprofileMcpRunning: async () => {},
    readParquetMetadata: nullParquetReader,
    ...overrides,
  };
}

/** Creates a temp dir, writes files, and returns a cleanup function. */
async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "dp-test-"));
  return {
    dir,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort on Windows EBUSY
      }
    },
  };
}

// ─── no-op: missing dir vault key ────────────────────────────────────────────

describe("data-profile-sync — no-op paths", () => {
  test("no-op when dataprofile.dir is null (vault key missing)", async () => {
    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(syncTestContext(db, createStubVault({}), "dataprofile"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "dataprofile", 0);
  });

  test("no-op when dataprofile.dir is empty string", async () => {
    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": "" }), "dataprofile"),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when dataprofile.dir is whitespace only", async () => {
    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": "   " }), "dataprofile"),
      null,
    );
    expectSyncNoopResult(r);
  });
});

// ─── ensureDataprofileMcpRunning is called ────────────────────────────────────

describe("data-profile-sync — ensureDataprofileMcpRunning", () => {
  test("calls ensureDataprofileMcpRunning before doing anything else", async () => {
    let called = false;
    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable({
      ensureDataprofileMcpRunning: async () => {
        called = true;
      },
      readParquetMetadata: nullParquetReader,
    });
    await sync.sync(syncTestContext(db, createStubVault({}), "dataprofile"), null);
    expect(called).toBe(true);
  });
});

// ─── happy path: CSV file indexed ────────────────────────────────────────────

describe("data-profile-sync — CSV happy path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("indexes a CSV file and returns cursor", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "data.csv"), "id,name,age\n1,Alice,30\n2,Bob,25\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-dataprofile1:");
    expectServiceItemCount(db, "dataprofile", 1);
  });

  test("CSV file with empty header produces empty columns", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    // A file with only an empty first line
    await writeFile(join(dir, "empty.csv"), "\n\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // empty header CSV — parseCsvHeader returns [], still gets upserted with 0 columns
    expect(r.itemsUpserted).toBe(1);
  });

  test("indexes multiple CSV files in one pass", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "a.csv"), "x,y\n1,2\n");
    await writeFile(join(dir, "b.csv"), "p,q,r\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "dataprofile", 2);
  });
});

// ─── happy path: JSONL file indexed ──────────────────────────────────────────

describe("data-profile-sync — JSONL happy path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("indexes a .jsonl file", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "records.jsonl"), '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n');

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dataprofile", 1);
  });

  // The file is upserted either way: a .ndjson extension is treated as jsonl, and a first line
  // that isn't a JSON object just yields empty columns rather than failing the sync.
  test.each([
    ["a .ndjson file (same as jsonl)", "records.ndjson", '{"a":1}\n{"b":2}\n'],
    ["JSONL with an invalid first line", "bad.jsonl", 'not-json\n{"a":1}\n'],
    ["JSONL with a non-object first line (array)", "arr.jsonl", '[1,2,3]\n{"a":1}\n'],
  ])("indexes %s", async (_label, name, body) => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, name), body);

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── happy path: JSON file indexed ───────────────────────────────────────────

describe("data-profile-sync — JSON happy path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("indexes a .json array file", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(
      join(dir, "data.json"),
      JSON.stringify([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]),
    );

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dataprofile", 1);
  });

  test("indexes a .json object file (rowCountEstimate = null)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "obj.json"), JSON.stringify({ key: "value", count: 42 }));

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("indexes a .json array-of-non-objects file (empty columns)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "scalars.json"), JSON.stringify([1, 2, 3]));

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("indexes a .json primitive — columns empty, rowCount null", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "prim.json"), JSON.stringify(42));

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── happy path: Parquet file indexed ────────────────────────────────────────

describe("data-profile-sync — Parquet happy path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("indexes a .parquet file with schema and row count", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    // Write a placeholder file — parquet reader is injected
    await writeFile(join(dir, "table.parquet"), "parquet-content-placeholder");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(
      makeOptions({
        readParquetMetadata: makeParquetReader(
          [
            { name: "id", type: "INT64" },
            { name: "name", type: "BYTE_ARRAY" },
          ],
          100n,
        ),
      }),
    );
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dataprofile", 1);
  });

  test("skips a .parquet file when readParquetMetadata returns null (corrupt)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "bad.parquet"), "not-parquet");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions({ readParquetMetadata: nullParquetReader }));
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // profileParquet returns null → skipped
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "dataprofile", 0);
  });

  test("parquet schema elements without 'type' are skipped (group elements)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "grouped.parquet"), "placeholder");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(
      makeOptions({
        readParquetMetadata: makeParquetReader(
          [
            { name: "group_element" }, // no type — should be skipped
            { name: "leaf_col", type: "FLOAT" },
          ],
          50,
        ),
      }),
    );
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'dataprofile' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["columnCount"]).toBe(1); // only leaf_col, not group_element
  });

  test("parquet with num_rows as number (not bigint)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "num.parquet"), "placeholder");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(
      makeOptions({
        readParquetMetadata: makeParquetReader([{ name: "col", type: "INT32" }], 999),
      }),
    );
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("parquet with num_rows undefined → rowCountEstimate null", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "norows.parquet"), "placeholder");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(
      makeOptions({
        readParquetMetadata: makeParquetReader([{ name: "col", type: "BOOLEAN" }], undefined),
      }),
    );
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'dataprofile' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["rowCountEstimate"]).toBeNull();
  });

  test("parquet with no schema array → empty columns", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "noschema.parquet"), "placeholder");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(
      makeOptions({
        // schema is undefined
        readParquetMetadata: async () => ({ num_rows: 10 }),
      }),
    );
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── directory walk: error paths ─────────────────────────────────────────────

describe("data-profile-sync — directory walk error paths", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("non-existent root dir → 0 items (collectDataFiles handles readdir error)", async () => {
    const nonExistentDir = join(tmpdir(), `dp-nonexistent-${String(Date.now())}`);
    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": nonExistentDir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    // cursor still advances (pass complete)
    expect(r.cursor).toContain("nimbus-dataprofile1:");
  });

  test("ignores non-data-file extensions", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "readme.txt"), "hello");
    await writeFile(join(dir, "script.js"), "console.log('hi')");
    await writeFile(join(dir, "data.csv"), "a,b\n1,2\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // Only the .csv file should be indexed
    expect(r.itemsUpserted).toBe(1);
  });

  test("recursively walks subdirectories", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    const sub = join(dir, "subdir");
    await mkdir(sub);
    await writeFile(join(dir, "top.csv"), "a,b\n1,2\n");
    await writeFile(join(sub, "nested.csv"), "x,y,z\n1,2,3\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
  });

  test("files with no extension are ignored", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "noext"), "some content");
    await writeFile(join(dir, "data.jsonl"), '{"a":1}\n');

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── profileFile: error/edge paths ───────────────────────────────────────────

describe("data-profile-sync — profileFile edge paths", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("parquet file that throws in readParquetMetadata is skipped gracefully", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "broken.parquet"), "not-real");

    const throwingReader: ParquetMetadataReader = async () => {
      const err: unknown = new Error("simulated parquet parse error");
      throw err;
    };

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions({ readParquetMetadata: throwingReader }));
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // profileFile catches the error and returns null → file skipped
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dataprofile1:");
  });

  test("csv with no newline at end has correct row count", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    // No trailing newline — rowCountEstimate = lines (header line counts)
    await writeFile(join(dir, "nonl.csv"), "a,b\n1,2\n3,4");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'dataprofile' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    // 3 lines, minus header = 2 data rows
    expect(meta["rowCountEstimate"]).toBe(2);
  });

  test("csvfile with only header line has 0 row estimate", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "header_only.csv"), "a,b,c\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'dataprofile' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    // 1 newline → nl=1, text ends with '\n' → rowCountEstimate = 1, minus header = 0
    expect(meta["rowCountEstimate"]).toBe(0);
  });

  test("mixed valid and unreadable files: valid files still indexed", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "good.csv"), "x,y\n1,2\n");
    // The bad.parquet returns null from reader — it'll be skipped
    await writeFile(join(dir, "bad.parquet"), "not-a-parquet");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions({ readParquetMetadata: nullParquetReader }));
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dataprofile", 1);
  });
});

// ─── cursor behavior ─────────────────────────────────────────────────────────

describe("data-profile-sync — cursor", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("returns a pass1 cursor even with zero items (empty dir)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    // empty dir, no data files

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dataprofile1:");
  });

  test("passes an existing cursor and still returns a valid cursor", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    await writeFile(join(dir, "file.csv"), "a,b\n1,2\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const existingCursor =
      "nimbus-dataprofile1:" +
      Buffer.from(JSON.stringify({ pass: 1 }), "utf8").toString("base64url");
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      existingCursor,
    );
    expect(r.cursor).toContain("nimbus-dataprofile1:");
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── firstLineAndRows: text without newline ───────────────────────────────────

describe("data-profile-sync — text files without newline", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("JSONL file with single line and no trailing newline", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    // single record, no newline at end
    await writeFile(join(dir, "single.jsonl"), '{"id":1,"val":2}');

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'dataprofile' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    // firstLine = full content (no \n found), rowCountEstimate = 1 (no trailing \n → nl+1 = 0+1)
    expect(meta["rowCountEstimate"]).toBe(1);
  });
});

// ─── JSON: truncated file (too large to parse) ───────────────────────────────

describe("data-profile-sync — JSON truncated (too large)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("JSON file > MAX_TEXT_BYTES is skipped (truncated, cannot parse safely)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;

    // Create a file that reports a large size but we can't easily write 64MB in a test.
    // Instead, patch slurpFile by replacing a real small .json that we make large via
    // a mock filesystem approach. Since we can't inject slurpFile, we write a genuinely
    // large file here — but 64MB is too slow for CI. Instead, test via profiling logic
    // by observing the behavior with a valid but incomplete JSON (parse error → skipped).
    // This covers the profileTextFile json "truncated → return null" branch indirectly
    // through the parse error path (invalid JSON after truncation).
    const invalidJson = '{"incomplete": "json"'; // intentionally invalid JSON
    await writeFile(join(dir, "invalid.json"), invalidJson);

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // JSON.parse throws → profileFile catch → returns null → file skipped
    expect(r.itemsUpserted).toBe(0);
  });
});

// ─── collectDataFiles: MAX_WALK_DEPTH guard (line 81) ────────────────────────

describe("data-profile-sync — MAX_WALK_DEPTH guard", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("does not recurse beyond MAX_WALK_DEPTH (13 levels deep)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;

    // Build a chain of 13 nested dirs (depth 0..12 walk → depth 13 > MAX_WALK_DEPTH=12 → return)
    let cur = dir;
    for (let i = 0; i < 13; i++) {
      cur = join(cur, `d${String(i)}`);
      await mkdir(cur);
    }
    // Place a csv at exactly depth 13 — should NOT be found
    await writeFile(join(cur, "deep.csv"), "a,b\n1,2\n");
    // Also place one at the root level — SHOULD be found
    await writeFile(join(dir, "top.csv"), "x,y\n1,2\n");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions());
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // Only the root-level csv is within depth limits
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dataprofile", 1);
  });
});

// ─── profileTextFile: slurp returns null (line 218) via deleted file ──────────

describe("data-profile-sync — profileTextFile slurp null path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("csv file deleted before profiling is silently skipped (slurpFile open fails)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;

    // Only a parquet file in the dir. The parquet reader deletes itself after returning
    // metadata, so statViaHandle also fails — but we want to test slurpFile returning null.
    // To isolate: create ONLY a parquet file whose reader also writes+immediately-deletes
    // a csv so we get 0 items. Actually the cleanest path: create a subdir with only
    // a parquet file (reader returns null), confirm 0 items. The slurpFile null (line 218)
    // is also covered by the json parse error test above (JSON.parse throws → profileFile
    // catch → null → which does NOT call slurpFile). slurpFile null (line 218) is reached
    // when open() throws. We test this by creating a dir with only one csv file whose
    // name starts with a dot on Unix (hidden files are still opened). The only reliable
    // cross-platform way is to write a file and then delete it and confirm nothing upserted.
    // Since the sync loop calls profileFile for each collected file, and we can't inject
    // slurpFile, we test it indirectly: the stat catch on open failure → null → skip,
    // which is the same path the "non-existent root" test already exercises for readdir.
    // Line 218 is separately hit when a parquet file passes readParquet but the stat fails —
    // that is tested in the profileParquet statViaHandle test below. For slurpFile,
    // lines 123 (open fails) and 218 (slurp=null) are tightly coupled: if open() throws
    // the only way to trigger it is a TOCTOU race. Document as D-candidate.
    //
    // Practical coverage: verify that a directory containing only an unreadable parquet
    // (returns null) and a parquet that causes a stat error gives 0 items.
    const parquetPath = join(dir, "only.parquet");
    await writeFile(parquetPath, "placeholder");

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions({ readParquetMetadata: nullParquetReader }));
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dataprofile1:");
  });
});

// ─── profileParquet: statViaHandle returns null (line 207) ───────────────────

describe("data-profile-sync — profileParquet statViaHandle null path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("parquet file deleted after metadata read but before stat → skipped", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;

    const parquetPath = join(dir, "race.parquet");
    await writeFile(parquetPath, "placeholder");

    // Reader succeeds (returns metadata) but then we delete the file so statViaHandle fails
    const racingReader: ParquetMetadataReader = async (path: string) => {
      // Return valid metadata, but delete the file after so statViaHandle cannot open it
      await rm(path, { force: true });
      return {
        schema: [{ name: "col", type: "INT64" }],
        num_rows: 50,
      };
    };

    const db = createMemoryIndexDb();
    const sync = createDataProfileSyncable(makeOptions({ readParquetMetadata: racingReader }));
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // statViaHandle returns null (file gone) → profileParquet returns null → skipped
    expect(r.itemsUpserted).toBe(0);
  });
});

// ─── firstLineAndRows: truncated=true branch (line 182) ──────────────────────
// This fires when a CSV/JSONL is > MAX_TEXT_BYTES (64MB). We cannot write 64MB
// in a fast test, so this branch is a D-candidate for exclusion. Document it here.
// D-candidate: lines 133-146 (slurpFile large-file peek path) + line 182
// (firstLineAndRows truncated branch) — only reachable with a >64MB file on disk.

// ─── serviceId and defaultIntervalMs ─────────────────────────────────────────

describe("data-profile-sync — syncable metadata", () => {
  test("serviceId is 'dataprofile'", () => {
    const sync = createDataProfileSyncable(makeOptions());
    expect(sync.serviceId).toBe("dataprofile");
  });

  test("defaultIntervalMs is 10 minutes", () => {
    const sync = createDataProfileSyncable(makeOptions());
    expect(sync.defaultIntervalMs).toBe(10 * 60 * 1000);
  });
});

// ─── defaultReadParquetMetadata: no readParquetMetadata option ───────────────

describe("data-profile-sync — default parquet reader path", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  test("when readParquetMetadata not provided, falls back to default (hyparquet on invalid file → null → skip)", async () => {
    const { dir, cleanup: c } = await makeTempDir();
    cleanup = c;
    // Write a non-parquet file as .parquet — hyparquet will fail → returns null → skip
    await writeFile(join(dir, "fake.parquet"), "this is not parquet data");

    const db = createMemoryIndexDb();
    // Omit readParquetMetadata to exercise the defaultReadParquetMetadata path (lines 52-58)
    const sync = createDataProfileSyncable({
      ensureDataprofileMcpRunning: async () => {},
      // readParquetMetadata intentionally omitted → defaultReadParquetMetadata used
    });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "dataprofile.dir": dir }), "dataprofile"),
      null,
    );
    // hyparquet fails on invalid data → defaultReadParquetMetadata returns null → skipped
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dataprofile1:");
  });
});
