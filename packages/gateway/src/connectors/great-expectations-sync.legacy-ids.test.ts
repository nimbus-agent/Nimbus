/**
 * Rows an older gateway wrote under the broken clamped id.
 *
 * Before the `clampExternalId` fix, every GX result whose `suite::batch::expectation::column` key
 * was longer than 256 chars was indexed as its first 240 chars plus `#0`. The fix gives each such
 * result its real id, so the next sync writes NEW rows — and since the syncable only upserts, the
 * old `#0` rows would otherwise stay in the index for good with a pass/fail that never updates.
 * The sync removes them, and must never remove a row it has just written.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  type GreatExpectationsMappingContext,
  legacyClampedExternalId,
  mapGreatExpectationsResultToItem,
} from "./great-expectations-result-mapping.ts";
import { createGreatExpectationsSyncable } from "./great-expectations-sync.ts";

const SERVICE = "great_expectations";
const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function result(expectationType: string, column: string): Record<string, unknown> {
  return {
    success: false,
    expectation_config: { expectation_type: expectationType, kwargs: { column } },
    result: { element_count: 10, unexpected_count: 1 },
  };
}

interface Artefact {
  readonly suite: string;
  readonly batchId: string;
  readonly results: readonly Record<string, unknown>[];
}

/** A results dir holding one file per artefact, and a fresh index to sync it into. */
async function setupArtefacts(
  artefacts: readonly Artefact[],
): Promise<{ db: Database; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gx-legacy-"));
  dirs.push(dir);
  for (const [i, a] of artefacts.entries()) {
    await writeFile(
      join(dir, `validation-${i}.json`),
      JSON.stringify({
        meta: { expectation_suite_name: a.suite, batch_id: a.batchId, run_id: "run-1" },
        results: a.results,
      }),
      "utf8",
    );
  }
  const db = createMemoryIndexDb();
  dbs.push(db);
  return { db, dir };
}

/** A results dir holding ONE artefact for `suite`/`batchId`, and a fresh index to sync it into. */
function setup(
  suite: string,
  batchId: string,
  results: readonly Record<string, unknown>[],
): Promise<{ db: Database; dir: string }> {
  return setupArtefacts([{ suite, batchId, results }]);
}

function sync(db: Database, dir: string) {
  return createGreatExpectationsSyncable({
    ensureGreatExpectationsMcpRunning: async () => {},
  }).sync(
    syncTestContext(db, createStubVault({ "great_expectations.results_dir": dir }), SERVICE),
    null,
  );
}

function externalIds(db: Database): string[] {
  const rows = db
    .query("SELECT external_id FROM item WHERE service = ? ORDER BY external_id")
    .all(SERVICE) as { external_id: string }[];
  return rows.map((r) => r.external_id);
}

function mappingCtx(suite: string, batchId: string): GreatExpectationsMappingContext {
  return {
    suiteName: suite,
    batchId,
    runId: "run-1",
    runTime: null,
    successPercent: null,
    syncedAt: 1,
    fileModifiedAt: null,
  };
}

describe("great-expectations-sync — rows written under the pre-fix clamped id", () => {
  test("an older gateway's `#0` row is removed once its result is indexed under the real id", async () => {
    // A long batch path: both results share their first 240 chars, so before the fix they
    // collapsed onto ONE `#0` row, the second upsert overwriting the first.
    const suite = "orders.critical";
    const batchId = `s3://warehouse/exports/${"daily-partition/".repeat(14)}orders.parquet`;
    const results = [
      result("expect_column_values_to_not_be_null", "order_id"),
      result("expect_column_values_to_be_unique", "customer_id"),
    ];
    const { db, dir } = await setup(suite, batchId, results);

    // What the old gateway left behind: the second result's row, under the shared `#0` id.
    const legacy = legacyClampedExternalId(results[1], mappingCtx(suite, batchId));
    expect(legacy).toBe(`${`${suite}::${batchId}`.slice(0, 240)}#0`);
    expect(legacyClampedExternalId(results[0], mappingCtx(suite, batchId))).toBe(legacy);
    const stale = mapGreatExpectationsResultToItem(results[1], mappingCtx(suite, batchId));
    if (stale === null || legacy === null) throw new Error("fixture did not map");
    syncTestContext(db, createStubVault({}), SERVICE).upsertItem({ ...stale, externalId: legacy });
    expect(externalIds(db)).toEqual([legacy]);

    const first = await sync(db, dir);

    const current = results.map(
      (r) => mapGreatExpectationsResultToItem(r, mappingCtx(suite, batchId))?.externalId ?? "",
    );
    expect(first.itemsUpserted).toBe(2);
    expect(first.itemsDeleted).toBe(1);
    expect(externalIds(db)).toEqual([...current].sort());
    expect(externalIds(db)).not.toContain(legacy);

    // Nothing left to remove: a later pass deletes nothing and keeps both rows.
    const second = await sync(db, dir);
    expect(second.itemsDeleted).toBe(0);
    expect(externalIds(db)).toEqual([...current].sort());
  });

  test("a row this pass wrote is kept even when its id equals another result's pre-fix id", async () => {
    // `long` is clamped, and its pre-fix id is the first 240 chars of its key plus `#0`. `short`
    // is 242 chars, under the cap, and spelled to be EXACTLY that string — so it is a current
    // row whose id is also a legacy id. Removing it would delete a live result every pass.
    const suite = "s";
    const batchId = "b1";
    const long = result("e", "x".repeat(260));
    const short = result("e", `${"x".repeat(230)}#0`);
    const { db, dir } = await setup(suite, batchId, [long, short]);

    const legacy = legacyClampedExternalId(long, mappingCtx(suite, batchId));
    const shortId = mapGreatExpectationsResultToItem(short, mappingCtx(suite, batchId))?.externalId;
    expect(shortId).toHaveLength(242);
    expect(shortId).toBe(legacy ?? "");

    const r = await sync(db, dir);

    expect(r.itemsUpserted).toBe(2);
    expect(r.itemsDeleted).toBe(0);
    expect(externalIds(db)).toContain(shortId ?? "");
    expect(externalIds(db)).toHaveLength(2);
  });

  test("a row this pass wrote is kept when a legacy id names it only through the primary key", async () => {
    // `itemPrimaryKey` keeps an external id that already starts with `great_expectations:` as it
    // is, and prefixes every other. So `a`'s pre-fix id (it starts with the prefix, because its
    // suite is literally that name) and `b`'s current id (the same string WITHOUT the prefix) are
    // different external ids naming ONE row. A guard comparing external ids lets the cleanup
    // delete `b`'s row on every pass; comparing primary keys keeps it.
    const a: Artefact = {
      suite: SERVICE,
      batchId: "s::b::t",
      results: [result("e", "c".repeat(300))],
    };
    const b: Artefact = {
      suite: ":s",
      batchId: "b",
      results: [result("t", `e::${"c".repeat(208)}#0`)],
    };
    const legacy = legacyClampedExternalId(a.results[0], mappingCtx(a.suite, a.batchId));
    const current = mapGreatExpectationsResultToItem(b.results[0], mappingCtx(b.suite, b.batchId));
    if (legacy === null || current === null) throw new Error("fixture did not map");
    expect(legacy.startsWith(`${SERVICE}:`)).toBe(true);
    expect(current.externalId).not.toBe(legacy);
    expect(`${SERVICE}:${current.externalId}`).toBe(legacy);
    const { db, dir } = await setupArtefacts([a, b]);

    const r = await sync(db, dir);

    expect(r.itemsUpserted).toBe(2);
    expect(r.itemsDeleted).toBe(0);
    expect(externalIds(db)).toHaveLength(2);
    expect(externalIds(db)).toContain(current.externalId);
  });
});
