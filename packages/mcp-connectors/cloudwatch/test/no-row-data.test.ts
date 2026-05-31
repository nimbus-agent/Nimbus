import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { CLOUDWATCH_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. CloudWatch exposes only log-group + stream
 * metadata tools; this locks that in. A future edit adding a
 * `cloudwatch_get_log_events` / `cloudwatch_filter_log_events` /
 * `cloudwatch_query` / `cloudwatch_get_query_results` / `cloudwatch_tail`
 * tool makes `assertNoRowDataTools` throw, failing CI.
 */
describe("CloudWatch no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = CLOUDWATCH_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "cloudwatch")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...CLOUDWATCH_TOOL_NAMES]).toEqual([
      "cloudwatch_list",
      "cloudwatch_get",
      "cloudwatch_search",
    ]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() =>
      assertNoRowDataTools([{ name: "cloudwatch_get_log_events" }], "cloudwatch"),
    ).toThrow();
  });
});
