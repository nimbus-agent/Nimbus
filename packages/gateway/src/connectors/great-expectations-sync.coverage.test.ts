/**
 * `deriveBatchId` fall-through the main suite does not reach: an `active_batch_definition` or
 * `batch_spec` block that IS present but carries no usable name must fall through to the next
 * source (and finally to "_") rather than produce an empty batch id.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createGreatExpectationsSyncable } from "./great-expectations-sync.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

/** Sync one artefact whose `meta` is `meta`; return the indexed row's batchId and externalId. */
async function syncOneArtefact(
  meta: Record<string, unknown>,
): Promise<{ batchId: unknown; externalId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gx-cov-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "validation.json"),
    JSON.stringify({
      meta: { expectation_suite_name: "orders", run_id: "run-1", ...meta },
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_x", kwargs: { column: "id" } },
          result: {},
        },
      ],
    }),
    "utf8",
  );
  const db = createMemoryIndexDb();
  try {
    const res = await createGreatExpectationsSyncable({
      ensureGreatExpectationsMcpRunning: async () => {},
    }).sync(
      syncTestContext(
        db,
        createStubVault({ "great_expectations.results_dir": dir }),
        "great_expectations",
      ),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
    const row = db
      .query("SELECT external_id, metadata FROM item WHERE service = 'great_expectations'")
      .get() as { external_id: string; metadata: string };
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    return { batchId: parsed["batchId"], externalId: row.external_id };
  } finally {
    db.close();
  }
}

describe("great-expectations-sync — batch id fall-through", () => {
  test("an active_batch_definition with only empty/non-string names falls through to batch_spec.path", async () => {
    const out = await syncOneArtefact({
      active_batch_definition: { batch_identifiers: "", data_asset_name: 5, datasource_name: "" },
      batch_spec: { path: "s3://warehouse/orders.parquet" },
    });
    expect(out.batchId).toBe("s3://warehouse/orders.parquet");
    expect(out.externalId).toBe("orders::s3://warehouse/orders.parquet::expect_x::id");
  });

  test("a batch_spec with an empty path and a non-string table_name yields the '_' batch id", async () => {
    const out = await syncOneArtefact({
      active_batch_definition: {},
      batch_spec: { path: "", table_name: 42 },
    });
    expect(out.batchId).toBe("_");
    expect(out.externalId).toBe("orders::_::expect_x::id");
  });
});
