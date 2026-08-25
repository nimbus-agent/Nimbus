import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGreatExpectationsSyncable } from "../../../src/connectors/great-expectations-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-gx1:";
function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const PII = "secret-pii@x.com";

function validationDoc() {
  return {
    success: false,
    statistics: { evaluated_expectations: 2, successful_expectations: 1, success_percent: 50 },
    meta: {
      expectation_suite_name: "orders.critical",
      run_id: { run_name: "ci-7", run_time: "2026-05-31T12:00:00.000Z" },
      batch_id: "batch-99",
    },
    results: [
      {
        success: true,
        expectation_config: {
          expectation_type: "expect_column_values_to_not_be_null",
          kwargs: { column: "order_id" },
        },
        result: { observed_value: 0, element_count: 10, unexpected_count: 0 },
      },
      {
        success: false,
        expectation_config: {
          expectation_type: "expect_column_values_to_be_unique",
          kwargs: { column: "email" },
        },
        result: {
          observed_value: 0.2,
          element_count: 10,
          unexpected_count: 2,
          unexpected_percent: 20,
          unexpected_list: [PII, "dupe@x.com"],
          partial_unexpected_list: [PII],
          partial_unexpected_index_list: [4, 5],
          unexpected_index_list: [4, 5],
          partial_unexpected_counts: [{ value: PII, count: 2 }],
        },
      },
    ],
  };
}

describe("great-expectations-sync", () => {
  let fx: ConnectorSyncFixture;
  let dir: string;
  const ensureCalls: number[] = [];

  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    dir = await mkdtemp(join(tmpdir(), "nimbus-gx-test-"));
    ensureCalls.length = 0;
  });
  afterEach(async () => {
    fx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  function makeSyncable() {
    return createGreatExpectationsSyncable({
      ensureGreatExpectationsMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
    });
  }

  test("no results_dir → noop, preserves cursor", async () => {
    const res = await makeSyncable().sync(fx.createSyncContext("great_expectations"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
  });

  test("walks JSON artefacts, upserts one item per results[] entry", async () => {
    await writeFile(join(dir, "result-a.json"), JSON.stringify(validationDoc()), "utf8");
    await fx.vault.set("great_expectations.results_dir", dir);

    const res = await makeSyncable().sync(fx.createSyncContext("great_expectations"), null);
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    const rows = fx.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'great_expectations' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "orders.critical::batch-99::expect_column_values_to_be_unique::email",
      "orders.critical::batch-99::expect_column_values_to_not_be_null::order_id",
    ]);
  });

  test("NEVER lets an unexpected-sample value reach the DB (no row data)", async () => {
    await writeFile(join(dir, "result-a.json"), JSON.stringify(validationDoc()), "utf8");
    await fx.vault.set("great_expectations.results_dir", dir);
    await makeSyncable().sync(fx.createSyncContext("great_expectations"), null);

    const all = fx.db
      .query<{ metadata: string; title: string; body_preview: string }, []>(
        "SELECT metadata, title, body_preview FROM item WHERE service = 'great_expectations'",
      )
      .all();
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain(PII);
    expect(serialized).not.toContain("dupe@x.com");
    expect(serialized).not.toContain("unexpected_list");
    expect(serialized).not.toContain("partial_unexpected_counts");
    // Aggregates ARE present.
    const uniqueMeta = JSON.parse(
      all.find((r) => r.metadata.includes("be_unique"))!.metadata,
    ) as Record<string, unknown>;
    expect(uniqueMeta.observedValue).toBe(0.2);
    expect(uniqueMeta.unexpectedCount).toBe(2);
  });

  test("recurses into nested dirs and skips non-JSON / unparseable files", async () => {
    const nested = join(dir, "uncommitted", "validations");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "deep.json"), JSON.stringify(validationDoc()), "utf8");
    await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    await fx.vault.set("great_expectations.results_dir", dir);

    const res = await makeSyncable().sync(fx.createSyncContext("great_expectations"), null);
    expect(res.itemsUpserted).toBe(2);
  });

  test("empty results array → success with zero upserts", async () => {
    await writeFile(
      join(dir, "empty.json"),
      JSON.stringify({ meta: { expectation_suite_name: "s" }, results: [] }),
      "utf8",
    );
    await fx.vault.set("great_expectations.results_dir", dir);
    const res = await makeSyncable().sync(fx.createSyncContext("great_expectations"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });
});
