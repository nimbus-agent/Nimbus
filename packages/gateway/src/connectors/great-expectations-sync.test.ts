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
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createGreatExpectationsSyncable } from "./great-expectations-sync.ts";

const NO_OP_MCP = async (): Promise<void> => {};

function makeSyncable() {
  return createGreatExpectationsSyncable({ ensureGreatExpectationsMcpRunning: NO_OP_MCP });
}

/** Write a JSON fixture to a temp file. Returns the dir path. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gx-test-"));
}

async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(data), "utf8");
  return p;
}

/** Minimal valid GX artefact with one result entry. */
function makeArtefact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      expectation_suite_name: "my_suite",
      batch_id: "batch-abc",
      run_id: "run-123",
      run_time: "2026-05-01T10:00:00.000Z",
    },
    statistics: { success_percent: 100 },
    results: [
      {
        expectation_config: {
          expectation_type: "expect_column_to_exist",
          kwargs: { column: "id" },
        },
        success: true,
        result: { element_count: 100, observed_value: 100 },
      },
    ],
    ...overrides,
  };
}

describe("great-expectations-sync", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── no-op when results_dir key is missing ───────────────────────────────
  testConnectorSyncNoop(
    "no-op when results_dir vault key is null",
    makeSyncable,
    createStubVault({ "great_expectations.results_dir": null }),
  );

  test("no-op when results_dir vault key is empty string", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": "" }),
        "great_expectations",
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when results_dir vault key is whitespace only", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": "   " }),
        "great_expectations",
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── happy path: valid artefact → items indexed ──────────────────────────
  test("indexes a valid GX artefact and returns itemsUpserted=1", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(dir, "result.json", makeArtefact());

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-gx1:");
    expectServiceItemCount(db, "great_expectations", 1);
  });

  // ─── cursor always advances even with zero items ─────────────────────────
  test("cursor advances to nimbus-gx1 even when directory is empty", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-gx1:");
    expectServiceItemCount(db, "great_expectations", 0);
  });

  // ─── unreadable directory is silently skipped ────────────────────────────
  test("handles non-existent results_dir without throwing (returns cursor)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": "/nonexistent/gx-test-path-xyz" }),
        "great_expectations",
      ),
      null,
    );
    // collectJsonFiles swallows the readdir error → no files → 0 upserted
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-gx1:");
  });

  // ─── file too large → skipped ────────────────────────────────────────────
  test("skips a file whose byte length exceeds MAX_FILE_BYTES (4 MB)", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    // Write a file just over 4 MB
    const oversize = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41); // 4MB+1 'A' chars
    const filePath = join(dir, "big.json");
    await writeFile(filePath, oversize);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "great_expectations", 0);
  });

  // ─── invalid JSON → skipped ──────────────────────────────────────────────
  test("skips a file with invalid JSON content", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeFile(join(dir, "bad.json"), "this is not json!!!");

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── JSON that is not an object (array at top level) → skipped ──────────
  test("skips a file whose top-level JSON is an array (not a record)", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(dir, "array.json", [1, 2, 3]);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── JSON null at top level → skipped ────────────────────────────────────
  test("skips a file whose top-level JSON is null", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(dir, "null.json", null);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── artefact with no "results" key (or non-array) → 0 upserted ─────────
  test("skips artefact when results field is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(dir, "no-results.json", { meta: {}, statistics: {} });

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("skips artefact when results field is not an array", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(dir, "results-string.json", { meta: {}, results: "not-an-array" });

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── results entry missing expectation_type → skipped ───────────────────
  test("skips a result entry that has no expectation_type", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    const data = makeArtefact({
      results: [
        {
          expectation_config: { kwargs: { column: "id" } }, // no expectation_type
          success: true,
          result: {},
        },
      ],
    });
    await writeJson(dir, "no-type.json", data);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("skips a result entry that has empty-string expectation_type", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    const data = makeArtefact({
      results: [
        {
          expectation_config: { expectation_type: "", kwargs: {} },
          success: true,
          result: {},
        },
      ],
    });
    await writeJson(dir, "empty-type.json", data);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── result entry that is not a record (primitive) → skipped ─────────────
  test("skips non-object entries in results array", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    const data = makeArtefact({
      results: [
        "not-an-object", // primitive — asRecord returns undefined
        {
          expectation_config: {
            expectation_type: "expect_column_to_exist",
            kwargs: { column: "id" },
          },
          success: true,
          result: {},
        },
      ],
    });
    await writeJson(dir, "mixed-results.json", data);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    // Only the valid entry is indexed
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── multiple files → all indexed ────────────────────────────────────────
  test("indexes multiple valid artefact files", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeJson(
      dir,
      "r1.json",
      makeArtefact({ meta: { expectation_suite_name: "suite_a", batch_id: "b1", run_id: "r1" } }),
    );
    await writeJson(
      dir,
      "r2.json",
      makeArtefact({ meta: { expectation_suite_name: "suite_b", batch_id: "b2", run_id: "r2" } }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "great_expectations", 2);
  });

  // ─── non-JSON files are ignored ──────────────────────────────────────────
  test("ignores non-.json files in the results directory", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeFile(join(dir, "readme.txt"), "not json");
    await writeFile(join(dir, "data.csv"), "a,b,c");
    await writeJson(dir, "valid.json", makeArtefact());

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── subdirectory walk ────────────────────────────────────────────────────
  test("recursively walks subdirectories", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    const sub = join(dir, "subdir");
    await mkdir(sub);
    await writeJson(
      sub,
      "result.json",
      makeArtefact({ meta: { expectation_suite_name: "nested", batch_id: "bx", run_id: "rx" } }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "great_expectations", 1);
  });

  // ─── deriveRunId: string run_id ──────────────────────────────────────────
  test("uses string run_id directly from meta", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { expectation_suite_name: "s", batch_id: "b", run_id: "my-run-id" },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runId"]).toBe("my-run-id");
  });

  // ─── deriveRunId: empty string run_id → falls through to object branch ───
  test("falls through to asRecord when run_id is empty string", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { expectation_suite_name: "s", batch_id: "b", run_id: "" },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── deriveRunId: object run_id with run_name ─────────────────────────────
  test("extracts run_name from object run_id", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { expectation_suite_name: "s", batch_id: "b", run_id: { run_name: "obj-run-name" } },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runId"]).toBe("obj-run-name");
  });

  // ─── deriveRunId: object run_id with run_time (no run_name) ──────────────
  test("falls back to run_time from object run_id when run_name is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          batch_id: "b",
          run_id: { run_time: "2026-05-01T00:00:00Z" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runId"]).toBe("2026-05-01T00:00:00Z");
  });

  // ─── deriveRunId: object run_id with neither run_name nor run_time ────────
  test("runId is null when object run_id has neither run_name nor run_time", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { expectation_suite_name: "s", batch_id: "b", run_id: { other_field: "x" } },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runId"]).toBeNull();
  });

  // ─── deriveRunTime: object run_id with run_time ───────────────────────────
  test("extracts runTime from object run_id.run_time when present", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          batch_id: "b",
          run_id: { run_time: "2026-05-01T10:00:00.000Z" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runTime"]).toBe("2026-05-01T10:00:00.000Z");
  });

  // ─── deriveRunTime: object run_id.run_time is empty string → fallback ────
  test("falls back to meta.run_time when object run_id.run_time is empty string", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          batch_id: "b",
          run_id: { run_time: "" },
          run_time: "2026-06-01T00:00:00.000Z",
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runTime"]).toBe("2026-06-01T00:00:00.000Z");
  });

  // ─── deriveRunTime: fallback to validation_time ───────────────────────────
  test("uses validation_time as runTime fallback when run_time is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          batch_id: "b",
          run_id: null, // not an object → object branch skipped
          validation_time: "2026-04-15T08:00:00.000Z",
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["runTime"]).toBe("2026-04-15T08:00:00.000Z");
  });

  // ─── deriveBatchId: direct batch_id ──────────────────────────────────────
  test("uses direct batch_id from meta", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { expectation_suite_name: "s", batch_id: "direct-batch", run_id: "r" },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("direct-batch");
  });

  // ─── deriveBatchId: active_batch_definition_id fallback ──────────────────
  test("falls back to active_batch_definition_id when batch_id is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          active_batch_definition_id: "abd-id-fallback",
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("abd-id-fallback");
  });

  // ─── deriveBatchId: active_batch_definition object → batch_identifiers ───
  test("extracts batch_identifiers from active_batch_definition object", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          active_batch_definition: { batch_identifiers: "batch-ident-value" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("batch-ident-value");
  });

  // ─── deriveBatchId: active_batch_definition → data_asset_name fallback ───
  test("extracts data_asset_name from active_batch_definition object when batch_identifiers absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          active_batch_definition: { data_asset_name: "my-asset" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("my-asset");
  });

  // ─── deriveBatchId: active_batch_definition → datasource_name fallback ───
  test("extracts datasource_name from active_batch_definition when others absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          active_batch_definition: { datasource_name: "my-datasource" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("my-datasource");
  });

  // ─── deriveBatchId: batch_spec → path ────────────────────────────────────
  test("extracts path from batch_spec when active_batch_definition is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          batch_spec: { path: "/data/file.parquet" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("/data/file.parquet");
  });

  // ─── deriveBatchId: batch_spec → table_name fallback ─────────────────────
  test("extracts table_name from batch_spec when path is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          batch_spec: { table_name: "orders_table" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("orders_table");
  });

  // ─── deriveBatchId: falls back to "_" when nothing present ───────────────
  test("batchId falls back to underscore when no batch fields are present", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { expectation_suite_name: "s", run_id: "r" },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("_");
  });

  // ─── deriveBatchId: empty-string batch_id falls through ──────────────────
  test("empty-string batch_id falls through to next source", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: {
          expectation_suite_name: "s",
          run_id: "r",
          batch_id: "", // empty → falls through
          batch_spec: { path: "/data/fallback.parquet" },
        },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["batchId"]).toBe("/data/fallback.parquet");
  });

  // ─── success=false result → failure flag stored ───────────────────────────
  test("indexes failed results (success=false)", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            expectation_config: {
              expectation_type: "expect_column_values_to_not_be_null",
              kwargs: { column: "email" },
            },
            success: false,
            result: { element_count: 50, unexpected_count: 5, unexpected_percent: 10.0 },
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["success"]).toBe(false);
    expect(meta["unexpectedCount"]).toBe(5);
    expect(meta["unexpectedPercent"]).toBe(10.0);
  });

  // ─── successPercent from statistics ──────────────────────────────────────
  test("reads successPercent from statistics field", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        statistics: { success_percent: 75.5 },
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["successPercent"]).toBe(75.5);
  });

  // ─── statistics absent → successPercent null ─────────────────────────────
  test("successPercent is null when statistics field is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    const data = makeArtefact();
    delete (data as Record<string, unknown>)["statistics"];
    await writeJson(dir, "r.json", data);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["successPercent"]).toBeNull();
  });

  // ─── suiteName defaults to "_" when expectation_suite_name absent ────────
  test("suiteName defaults to underscore when not in meta", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        meta: { batch_id: "b", run_id: "r" }, // no expectation_suite_name
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["suiteName"]).toBe("_");
  });

  // ─── meta field absent → empty defaults ──────────────────────────────────
  test("handles missing meta field in artefact gracefully", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    const data = makeArtefact();
    delete (data as Record<string, unknown>)["meta"];
    await writeJson(dir, "r.json", data);

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["suiteName"]).toBe("_");
    expect(meta["batchId"]).toBe("_");
    expect(meta["runId"]).toBeNull();
  });

  // ─── observed_value: numeric scalar ──────────────────────────────────────
  test("stores numeric observed_value as scalar", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            expectation_config: {
              expectation_type: "expect_column_mean_to_be_between",
              kwargs: { column: "age" },
            },
            success: true,
            result: { observed_value: 42.5 },
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["observedValue"]).toBe(42.5);
  });

  // ─── observed_value: string scalar ───────────────────────────────────────
  test("stores string observed_value as scalar", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            expectation_config: {
              expectation_type: "expect_column_values_to_match_regex",
              kwargs: { column: "code" },
            },
            success: true,
            result: { observed_value: "hello" },
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["observedValue"]).toBe("hello");
  });

  // ─── observed_value: boolean scalar ──────────────────────────────────────
  test("stores boolean observed_value as scalar", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            expectation_config: {
              expectation_type: "expect_table_row_count_to_be_between",
              kwargs: {},
            },
            success: false,
            result: { observed_value: false },
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["observedValue"]).toBe(false);
  });

  // ─── observed_value: array/object → dropped (null) ────────────────────────
  test("drops non-scalar observed_value (array) — forbidden data cell", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            expectation_config: {
              expectation_type: "expect_column_values_to_be_in_set",
              kwargs: { column: "status" },
            },
            success: false,
            result: { observed_value: ["foo", "bar", "baz"] },
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["observedValue"]).toBeNull();
  });

  // ─── column absent in kwargs → "_" suffix in external_id ─────────────────
  test("uses null column when kwargs has no column field", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            expectation_config: { expectation_type: "expect_table_row_count_to_equal", kwargs: {} },
            success: true,
            result: { observed_value: 100 },
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'great_expectations' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["column"]).toBeNull();
  });

  // ─── expectation_config absent → entry treated as {} ─────────────────────
  test("skips result entry when expectation_config is absent", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(
      dir,
      "r.json",
      makeArtefact({
        results: [
          {
            // no expectation_config at all
            success: true,
            result: {},
          },
        ],
      }),
    );

    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── cursor is passed through on sync call ────────────────────────────────
  test("returns nimbus-gx1 cursor on repeated sync (cursor passed in is ignored, new one issued)", async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);
    await writeJson(dir, "r.json", makeArtefact());

    const db = createMemoryIndexDb();
    const r1 = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    const r2 = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      r1.cursor,
    );
    expect(r2.cursor).toContain("nimbus-gx1:");
    expect(r2.itemsUpserted).toBeGreaterThanOrEqual(0);
  });

  // ─── serviceId and defaults ───────────────────────────────────────────────
  test("serviceId is great_expectations", () => {
    const sync = makeSyncable();
    expect(sync.serviceId).toBe("great_expectations");
  });

  test("defaultIntervalMs is 10 minutes", () => {
    const sync = makeSyncable();
    expect(sync.defaultIntervalMs).toBe(10 * 60 * 1000);
  });

  test("initialSyncDepthDays is 30", () => {
    const sync = makeSyncable();
    expect(sync.initialSyncDepthDays).toBe(30);
  });
});
