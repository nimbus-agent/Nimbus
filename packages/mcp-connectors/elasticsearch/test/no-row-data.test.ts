import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { ELASTICSEARCH_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. Elasticsearch exposes only schema/metadata tools
 * (index listing, mapping/get, name search); this locks that in. A future edit
 * adding an `elasticsearch_search_records` / `elasticsearch_get_doc` /
 * `elasticsearch_scan` / `elasticsearch_query` / `elasticsearch_export` tool
 * makes `assertNoRowDataTools` throw, failing CI. `elasticsearch_search` is fine
 * because `search` is an allowed segment (it searches index NAMES, not documents).
 */
describe("Elasticsearch no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = ELASTICSEARCH_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "elasticsearch")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...ELASTICSEARCH_TOOL_NAMES]).toEqual([
      "elasticsearch_list",
      "elasticsearch_get",
      "elasticsearch_search",
    ]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "elasticsearch_scan" }], "elasticsearch")).toThrow();
    expect(() =>
      assertNoRowDataTools([{ name: "elasticsearch_get_records" }], "elasticsearch"),
    ).toThrow();
  });
});
