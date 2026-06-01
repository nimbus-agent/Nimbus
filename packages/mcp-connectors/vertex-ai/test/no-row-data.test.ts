import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { cliArg, VERTEX_AI_TOOL_NAMES } from "../src/tools.ts";

/**
 * Tier-3 no-row-data contract. Vertex AI exposes only model-REGISTRY metadata
 * tools; this locks that in. A future edit adding a `vertex_ai_predict` /
 * `vertex_ai_explain` / `vertex_ai_get_records` / `vertex_ai_query` /
 * `vertex_ai_scan` tool makes `assertNoRowDataTools` throw, failing CI.
 * (`gcloud ai endpoints predict` / `explain` / `raw-predict` are forbidden by
 * design — they would map to denylisted segments.)
 */
describe("Vertex AI no-row-data contract (Tier-3)", () => {
  it("exposes only metadata tools — assertNoRowDataTools does not throw", () => {
    const tools = VERTEX_AI_TOOL_NAMES.map((name) => ({ name }));
    expect(() => assertNoRowDataTools(tools, "vertex_ai")).not.toThrow();
  });

  it("registers the expected metadata-only tool surface", () => {
    expect([...VERTEX_AI_TOOL_NAMES]).toEqual([
      "vertex_ai_list",
      "vertex_ai_get",
      "vertex_ai_search",
    ]);
  });

  it("rejects a hypothetical row-data tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "vertex_ai_scan" }], "vertex_ai")).toThrow();
    expect(() => assertNoRowDataTools([{ name: "vertex_ai_get_records" }], "vertex_ai")).toThrow();
  });
});

/**
 * Security guard: every tool-input value passed to the `gcloud ai` CLI (a model
 * id or a region) flows through the `cliArg` Zod field, which rejects argv
 * flag-smuggling. A value beginning with `-` (or carrying control chars) must
 * fail the schema before the handler ever shells out.
 */
describe("Vertex AI cliArg flag-smuggling guard", () => {
  it("accepts a normal model id and region", () => {
    expect(cliArg.safeParse("1234567890123456789").success).toBe(true);
    expect(cliArg.safeParse("us-central1").success).toBe(true);
  });

  it("rejects a `-`-prefixed model id (argv flag smuggling)", () => {
    expect(cliArg.safeParse("--project=attacker").success).toBe(false);
    expect(cliArg.safeParse("-h").success).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(cliArg.safeParse("").success).toBe(false);
  });

  it("rejects a value with control characters", () => {
    expect(cliArg.safeParse("model\nname").success).toBe(false);
  });
});
