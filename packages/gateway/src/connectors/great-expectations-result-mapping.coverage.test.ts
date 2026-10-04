/**
 * The two GX mapper paths the main suite leaves dark: an external id longer than the 256-char cap
 * (clamped to a 240-char prefix plus a `#<hex>` hash suffix), and an entry whose
 * `expectation_config.kwargs` and `result` blocks are absent altogether.
 *
 * The suffix VALUES are pinned, not just their shape: the clamped id is the row's persisted
 * external id, so any change to the hash re-keys every over-long row and orphans the old one. The
 * pinned values were computed independently (BigInt arithmetic over the id's code points, mod 2^32).
 * They also guard a real regression: the hash was once left unreduced (`Math.trunc(h * 31 + cp)`),
 * which loses all 32 low bits past ~17 chars, so EVERY clamped id ended in `#0` and two results
 * sharing their first 240 chars overwrote each other.
 */
import { describe, expect, test } from "bun:test";

import {
  type GreatExpectationsMappingContext,
  legacyClampedExternalId,
  mapGreatExpectationsResultToItem,
} from "./great-expectations-result-mapping.ts";

const SYNCED_AT = 1_717_000_000_000;
const ID_MAX = 256;

function ctx(suiteName: string): GreatExpectationsMappingContext {
  return {
    suiteName,
    batchId: "b",
    runId: null,
    runTime: null,
    successPercent: null,
    syncedAt: SYNCED_AT,
    fileModifiedAt: null,
  };
}

/** The unclamped id the mapper builds: `<suite>::<batch>::<type>::<column>`. */
function rawId(suiteName: string, column: string): string {
  return `${suiteName}::b::expect_x::${column}`;
}

function entry(column: string): unknown {
  return { expectation_config: { expectation_type: "expect_x", kwargs: { column } } };
}

describe("mapGreatExpectationsResultToItem — external id clamp", () => {
  test("an id of exactly the cap is kept verbatim", () => {
    // 256 - "::b::expect_x::c".length = 240
    const suite = "s".repeat(ID_MAX - "::b::expect_x::c".length);
    expect(rawId(suite, "c")).toHaveLength(ID_MAX);
    const row = mapGreatExpectationsResultToItem(entry("c"), ctx(suite));
    expect(row?.externalId).toBe(rawId(suite, "c"));
  });

  test("an id one char over the cap becomes its first 240 chars plus a '#<hex>' suffix", () => {
    const suite = "s".repeat(ID_MAX - "::b::expect_x::c".length + 1);
    const full = rawId(suite, "c");
    expect(full).toHaveLength(ID_MAX + 1);

    const row = mapGreatExpectationsResultToItem(entry("c"), ctx(suite));
    const id = row?.externalId ?? "";
    expect(id).toBe(`${full.slice(0, ID_MAX - 16)}#1c577e22`);
    expect(id.length).toBeLessThanOrEqual(ID_MAX);
    // The clamp is deterministic: the same entry always lands on the same row.
    expect(mapGreatExpectationsResultToItem(entry("c"), ctx(suite))?.externalId).toBe(id);
  });

  test("two over-long ids sharing their first 240 chars stay distinct rows", () => {
    // A long batch path pushes both expectations' distinguishing tail past the 240-char prefix.
    const batchId = `s3://warehouse/exports/${"daily-partition/".repeat(14)}orders.parquet`;
    const notNull = mapGreatExpectationsResultToItem(
      {
        expectation_config: {
          expectation_type: "expect_column_values_to_not_be_null",
          kwargs: { column: "order_id" },
        },
      },
      { ...ctx("orders.critical"), batchId },
    );
    const unique = mapGreatExpectationsResultToItem(
      {
        expectation_config: {
          expectation_type: "expect_column_values_to_be_unique",
          kwargs: { column: "customer_id" },
        },
      },
      { ...ctx("orders.critical"), batchId },
    );
    const prefix = `orders.critical::${batchId}`.slice(0, ID_MAX - 16);
    expect(prefix).toHaveLength(ID_MAX - 16);
    expect(notNull?.externalId).toBe(`${prefix}#f01dba42`);
    expect(unique?.externalId).toBe(`${prefix}#2390d610`);
    expect(notNull?.externalId).not.toBe(unique?.externalId);
  });

  test("the suffix hashes code points, so an astral-plane id clamps to its own stable value", () => {
    const suite = "\u{1F600}".repeat(130);
    const row = mapGreatExpectationsResultToItem(entry("c"), ctx(suite));
    expect(row?.externalId).toBe(`${rawId(suite, "c").slice(0, ID_MAX - 16)}#6ad9d0af`);
  });

  test("the clamp applies to the external id only — title and metadata keep the full names", () => {
    const suite = "q".repeat(400);
    const row = mapGreatExpectationsResultToItem(entry("email"), ctx(suite));
    expect(row?.externalId.length).toBeLessThanOrEqual(ID_MAX);
    expect(row?.metadata["suiteName"]).toBe(suite);
    expect(row?.metadata["column"]).toBe("email");
  });
});

describe("mapGreatExpectationsResultToItem — absent kwargs and result", () => {
  test("an entry with neither kwargs nor result maps as a table-level, metric-less failure", () => {
    const row = mapGreatExpectationsResultToItem(
      { expectation_config: { expectation_type: "expect_table_columns_to_match_set" } },
      ctx("orders.critical"),
    );
    expect(row).not.toBeNull();
    expect(row?.externalId).toBe("orders.critical::b::expect_table_columns_to_match_set::_");
    expect(row?.title).toBe("orders.critical · expect_table_columns_to_match_set()");
    expect(row?.bodyPreview).toBe("expect_table_columns_to_match_set on (table) — failed");
    expect(row?.metadata["column"]).toBeNull();
    expect(row?.metadata["success"]).toBe(false);
    expect(row?.metadata["observedValue"]).toBeNull();
    expect(row?.metadata["elementCount"]).toBeNull();
    expect(row?.metadata["unexpectedCount"]).toBeNull();
    expect(row?.metadata["unexpectedPercent"]).toBeNull();
  });

  test("non-object kwargs and result are treated exactly like absent ones", () => {
    const row = mapGreatExpectationsResultToItem(
      {
        success: true,
        expectation_config: { expectation_type: "expect_x", kwargs: ["column", "email"] },
        result: "observed_value=3",
      },
      ctx("s"),
    );
    expect(row?.externalId).toBe("s::b::expect_x::_");
    expect(row?.bodyPreview).toBe("expect_x on (table) — passed");
    expect(row?.metadata["observedValue"]).toBeNull();
  });
});

/** The clamp as it shipped before the fix, verbatim — the hash left unreduced. */
function clampedIdBeforeTheFix(id: string): string {
  if (id.length <= ID_MAX) return id;
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = Math.trunc(h * 31 + (id.codePointAt(i) ?? 0));
  }
  return `${id.slice(0, ID_MAX - 16)}#${(h >>> 0).toString(16)}`;
}

describe("legacyClampedExternalId — the id an over-long result had before the fix", () => {
  test("is exactly what the pre-fix clamp produced, and differs from today's id", () => {
    for (const suite of ["s".repeat(241), "q".repeat(400), "\u{1F600}".repeat(130)]) {
      const full = rawId(suite, "c");
      const legacy = legacyClampedExternalId(entry("c"), ctx(suite));
      expect(legacy).toBe(clampedIdBeforeTheFix(full));
      expect(legacy).toBe(`${full.slice(0, ID_MAX - 16)}#0`);
      expect(legacy).not.toBe(mapGreatExpectationsResultToItem(entry("c"), ctx(suite))?.externalId);
    }
  });

  test("an id within the cap was never clamped, so it has no older id", () => {
    const suite = "s".repeat(ID_MAX - "::b::expect_x::c".length);
    expect(rawId(suite, "c")).toHaveLength(ID_MAX);
    expect(legacyClampedExternalId(entry("c"), ctx(suite))).toBeNull();
  });

  test("an entry the mapper does not index has no older id either", () => {
    const suite = "s".repeat(300);
    expect(legacyClampedExternalId(null, ctx(suite))).toBeNull();
    expect(legacyClampedExternalId({ expectation_config: {} }, ctx(suite))).toBeNull();
  });
});
