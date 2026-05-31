import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { ATHENA_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. Athena exposes only catalog/database/table
 * metadata tools; this locks that in. A future edit adding an
 * `athena_run_query` / `athena_get_query_results` / `athena_rows` /
 * `athena_scan` / `athena_sample` tool makes `assertNoRowDataTools` throw,
 * failing CI.
 */
describe("Athena no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = ATHENA_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "athena")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...ATHENA_TOOL_NAMES]).toEqual(["athena_list", "athena_get", "athena_search"]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "athena_get_query_results" }], "athena")).toThrow();
  });
});
