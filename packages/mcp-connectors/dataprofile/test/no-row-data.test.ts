import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { DATAPROFILE_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-5 no-row-data contract. The data-profiling connector exposes only
 * schema-METADATA tools; this locks that in. A future edit adding a
 * `dataprofile_sample` / `dataprofile_get_rows` / `dataprofile_preview` tool
 * makes `assertNoRowDataTools` throw, failing CI.
 */
describe("Local data profiling no-row-data contract (Tier-5)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = DATAPROFILE_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "dataprofile")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...DATAPROFILE_TOOL_NAMES]).toEqual([
      "dataprofile_list",
      "dataprofile_get",
      "dataprofile_search",
    ]);
  });

  it("rejects hypothetical row-data tools (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "dataprofile_sample" }], "dataprofile")).toThrow();
    expect(() => assertNoRowDataTools([{ name: "dataprofile_get_rows" }], "dataprofile")).toThrow();
    expect(() => assertNoRowDataTools([{ name: "dataprofile_preview" }], "dataprofile")).toThrow();
  });
});
