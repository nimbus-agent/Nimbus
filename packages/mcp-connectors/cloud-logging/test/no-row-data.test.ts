import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { CLOUD_LOGGING_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. Cloud Logging exposes only routing-sink
 * configuration metadata tools; this locks that in. A future edit adding a
 * `cloud_logging_get_events` / `cloud_logging_query` /
 * `cloud_logging_get_records` tool makes `assertNoRowDataTools` throw,
 * failing CI. (`gcloud logging read` / `entries list` row-data commands map to
 * these denylisted segments — `events` / `query` / `records`.)
 */
describe("Cloud Logging no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = CLOUD_LOGGING_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "cloud_logging")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...CLOUD_LOGGING_TOOL_NAMES]).toEqual([
      "cloud_logging_list",
      "cloud_logging_get",
      "cloud_logging_search",
    ]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() =>
      assertNoRowDataTools([{ name: "cloud_logging_get_events" }], "cloud_logging"),
    ).toThrow();
  });
});
