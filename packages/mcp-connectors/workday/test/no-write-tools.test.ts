import { describe, expect, it } from "bun:test";
import { assertNoRowDataTools } from "@nimbus-dev/sdk";
import { WORKDAY_TOOL_NAMES } from "../src/tools.ts";

describe("Workday no-row-data + read-only contract", () => {
  it("registers only the metadata read tools", () => {
    expect([...WORKDAY_TOOL_NAMES]).toEqual(["workday_list", "workday_get", "workday_search"]);
  });

  it("exposes no row/cell/query tool — assertNoRowDataTools does not throw", () => {
    expect(() =>
      assertNoRowDataTools(
        WORKDAY_TOOL_NAMES.map((name) => ({ name })),
        "workday",
      ),
    ).not.toThrow();
  });

  it("rejects a hypothetical row/query tool (assertion is live)", () => {
    expect(() => assertNoRowDataTools([{ name: "workday_run_query" }], "workday")).toThrow();
  });

  it("has no create/update/delete/write tool name", () => {
    const writeish = WORKDAY_TOOL_NAMES.filter((n) =>
      /_(create|update|delete|write|promote|sync|put|post)$/.test(n),
    );
    expect(writeish).toEqual([]);
  });
});
