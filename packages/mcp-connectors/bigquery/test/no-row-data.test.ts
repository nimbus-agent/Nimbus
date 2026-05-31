import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { BIGQUERY_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. BigQuery exposes only schema/metadata tools; this
 * locks that in. A future edit adding a `bigquery_query` / `bigquery_rows` /
 * `bigquery_sample` / `bigquery_scan` / `bigquery_head` / `bigquery_export` tool
 * makes `assertNoRowDataTools` throw, failing CI.
 */
describe("BigQuery no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = BIGQUERY_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "bigquery")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...BIGQUERY_TOOL_NAMES]).toEqual(["bigquery_list", "bigquery_get", "bigquery_search"]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "bigquery_run_query" }], "bigquery")).toThrow();
  });
});
