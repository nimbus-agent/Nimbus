import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { FORBIDDEN_RESULT_KEYS, parseValidationResult } from "../src/gx-parse.ts";
import { GREAT_EXPECTATIONS_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. Great Expectations exposes only validation
 * METADATA tools; this locks that in. A future edit adding a
 * `great_expectations_get_unexpected_rows` / `great_expectations_sample` /
 * `great_expectations_get_records` tool makes `assertNoRowDataTools` throw,
 * failing CI.
 */
describe("Great Expectations no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = GREAT_EXPECTATIONS_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "great_expectations")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...GREAT_EXPECTATIONS_TOOL_NAMES]).toEqual([
      "great_expectations_list",
      "great_expectations_get",
      "great_expectations_search",
    ]);
  });

  it("rejects hypothetical row-data tools (assertion is live)", () => {
    expect(() =>
      assertNoRowDataTools(
        [{ name: "great_expectations_get_unexpected_rows" }],
        "great_expectations",
      ),
    ).toThrow();
    expect(() =>
      assertNoRowDataTools([{ name: "great_expectations_sample" }], "great_expectations"),
    ).toThrow();
  });
});

/**
 * The parser is the no-row-data backstop on the MCP side: even when the input
 * `result` carries failing-data sample lists with real PII cell values, none of
 * those values may appear anywhere in the parsed metadata.
 */
describe("Great Expectations parser strips failing-data samples", () => {
  const PII = "secret-pii@example.com";

  const doc = {
    success: false,
    statistics: { evaluated_expectations: 1, success_percent: 0 },
    meta: {
      expectation_suite_name: "customers.warning",
      run_id: { run_name: "ci-42", run_time: "2026-05-31T10:00:00.000Z" },
      batch_id: "batch-abc",
    },
    results: [
      {
        success: false,
        expectation_config: {
          expectation_type: "expect_column_values_to_be_unique",
          kwargs: { column: "email" },
        },
        result: {
          observed_value: 0.25,
          element_count: 4,
          unexpected_count: 1,
          unexpected_percent: 25,
          unexpected_list: [PII, "another-pii@example.com"],
          partial_unexpected_list: [PII],
          partial_unexpected_index_list: [3],
          unexpected_index_list: [3],
          partial_unexpected_counts: [{ value: PII, count: 1 }],
        },
      },
    ],
  };

  it("never copies any forbidden sample list value into the metadata", () => {
    const rows = parseValidationResult(doc, "validations/customers.json");
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PII);
    expect(serialized).not.toContain("another-pii@example.com");
    for (const key of FORBIDDEN_RESULT_KEYS) {
      expect(serialized).not.toContain(key);
    }
  });

  it("keeps the aggregate scalar metrics", () => {
    const [row] = parseValidationResult(doc, "validations/customers.json");
    expect(row?.suiteName).toBe("customers.warning");
    expect(row?.batchId).toBe("batch-abc");
    expect(row?.expectationType).toBe("expect_column_values_to_be_unique");
    expect(row?.column).toBe("email");
    expect(row?.success).toBe(false);
    expect(row?.observedValue).toBe(0.25);
    expect(row?.elementCount).toBe(4);
    expect(row?.unexpectedCount).toBe(1);
    expect(row?.externalId).toBe(
      "customers.warning::batch-abc::expect_column_values_to_be_unique::email",
    );
  });

  it("drops observed_value when it is an array of sampled values", () => {
    const arrDoc = {
      meta: { expectation_suite_name: "s", batch_id: "b" },
      results: [
        {
          success: true,
          expectation_config: { expectation_type: "expect_x", kwargs: {} },
          result: { observed_value: ["sampled-a", "sampled-b"] },
        },
      ],
    };
    const [row] = parseValidationResult(arrDoc, "x.json");
    expect(row?.observedValue).toBeNull();
    expect(JSON.stringify(row)).not.toContain("sampled-a");
  });
});
