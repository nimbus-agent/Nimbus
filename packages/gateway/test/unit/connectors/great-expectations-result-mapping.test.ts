import { describe, expect, it } from "bun:test";
import {
  type GreatExpectationsMappingContext,
  GX_FORBIDDEN_RESULT_KEYS,
  mapGreatExpectationsResultToItem,
} from "../../../src/connectors/great-expectations-result-mapping.ts";

const SYNCED_AT = 1_717_000_000_000;

function baseCtx(
  overrides: Partial<GreatExpectationsMappingContext> = {},
): GreatExpectationsMappingContext {
  return {
    suiteName: "customers.warning",
    batchId: "batch-abc",
    runId: "ci-42",
    runTime: "2026-05-31T10:00:00.000Z",
    successPercent: 75,
    syncedAt: SYNCED_AT,
    fileModifiedAt: null,
    ...overrides,
  };
}

describe("mapGreatExpectationsResultToItem", () => {
  it("maps a passing expectation to a data_quality_test item", () => {
    const entry = {
      success: true,
      expectation_config: {
        expectation_type: "expect_column_values_to_not_be_null",
        kwargs: { column: "email" },
      },
      result: {
        observed_value: 0,
        element_count: 100,
        unexpected_count: 0,
        unexpected_percent: 0,
      },
    };
    const item = mapGreatExpectationsResultToItem(entry, baseCtx());
    expect(item).not.toBeNull();
    expect(item?.service).toBe("great_expectations");
    expect(item?.type).toBe("data_quality_test");
    expect(item?.externalId).toBe(
      "customers.warning::batch-abc::expect_column_values_to_not_be_null::email",
    );
    expect(item?.title).toBe("customers.warning · expect_column_values_to_not_be_null(email)");
    expect(item?.url).toBeNull();
    expect(item?.canonicalUrl).toBeNull();
    expect(item?.modifiedAt).toBe(Date.parse("2026-05-31T10:00:00.000Z"));
    expect(item?.metadata.success).toBe(true);
    expect(item?.metadata.observedValue).toBe(0);
    expect(item?.metadata.elementCount).toBe(100);
    expect(item?.metadata.successPercent).toBe(75);
    expect(item?.syncedAt).toBe(SYNCED_AT);
  });

  it("uses '_' for the column segment when no column kwarg", () => {
    const entry = {
      success: false,
      expectation_config: { expectation_type: "expect_table_row_count_to_be_between", kwargs: {} },
      result: { observed_value: 42 },
    };
    const item = mapGreatExpectationsResultToItem(entry, baseCtx());
    expect(item?.externalId).toBe(
      "customers.warning::batch-abc::expect_table_row_count_to_be_between::_",
    );
    expect(item?.metadata.column).toBeNull();
    expect(item?.metadata.success).toBe(false);
  });

  it("returns null when the expectation type is missing", () => {
    expect(mapGreatExpectationsResultToItem({ success: true, result: {} }, baseCtx())).toBeNull();
    expect(mapGreatExpectationsResultToItem(null, baseCtx())).toBeNull();
    expect(mapGreatExpectationsResultToItem("not-an-object", baseCtx())).toBeNull();
  });

  it("falls back to fileModifiedAt then syncedAt when run time is unparseable", () => {
    const withMtime = mapGreatExpectationsResultToItem(
      { expectation_config: { expectation_type: "expect_x", kwargs: {} }, result: {} },
      baseCtx({ runTime: "not-a-date", fileModifiedAt: 123456 }),
    );
    expect(withMtime?.modifiedAt).toBe(123456);

    const withSynced = mapGreatExpectationsResultToItem(
      { expectation_config: { expectation_type: "expect_x", kwargs: {} }, result: {} },
      baseCtx({ runTime: null, fileModifiedAt: null }),
    );
    expect(withSynced?.modifiedAt).toBe(SYNCED_AT);
  });

  it("drops observed_value when it is an array/object of sampled values", () => {
    const item = mapGreatExpectationsResultToItem(
      {
        success: false,
        expectation_config: {
          expectation_type: "expect_column_distinct_values_to_be_in_set",
          kwargs: { column: "status" },
        },
        result: { observed_value: ["sampled-a", "sampled-b"], element_count: 9 },
      },
      baseCtx(),
    );
    expect(item?.metadata.observedValue).toBeNull();
    expect(item?.metadata.elementCount).toBe(9);
    expect(JSON.stringify(item?.metadata)).not.toContain("sampled-a");
  });

  // The load-bearing no-row-data assertion: even when the input `result` carries
  // the failing-data sample lists with real PII cell values, NONE of those
  // values may appear anywhere in the produced item's metadata.
  it("NEVER indexes the unexpected-sample lists (no row data)", () => {
    const PII = "secret-pii@x.com";
    const entry = {
      success: false,
      expectation_config: {
        expectation_type: "expect_column_values_to_be_unique",
        kwargs: { column: "email" },
      },
      result: {
        observed_value: 0.5,
        element_count: 4,
        unexpected_count: 2,
        unexpected_percent: 50,
        unexpected_list: [PII, "another@x.com"],
        partial_unexpected_list: [PII],
        partial_unexpected_index_list: [3, 4],
        unexpected_index_list: [3, 4],
        partial_unexpected_counts: [{ value: PII, count: 2 }],
      },
    };
    const item = mapGreatExpectationsResultToItem(entry, baseCtx());
    expect(item).not.toBeNull();
    const serialized = JSON.stringify(item?.metadata);
    expect(serialized).not.toContain(PII);
    expect(serialized).not.toContain("another@x.com");
    for (const key of GX_FORBIDDEN_RESULT_KEYS) {
      expect(serialized).not.toContain(key);
    }
    // Aggregate metrics are kept.
    expect(item?.metadata.observedValue).toBe(0.5);
    expect(item?.metadata.unexpectedCount).toBe(2);
  });
});
