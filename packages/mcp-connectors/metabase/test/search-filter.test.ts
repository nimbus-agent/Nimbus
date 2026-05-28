import { describe, expect, test } from "bun:test";

import { filterMetabaseDashboards } from "../src/search-filter.ts";

function dashboard(over: { name?: string; description?: string | null }): Record<string, unknown> {
  return {
    id: 1,
    name: over.name ?? "Revenue Overview",
    description: over.description === undefined ? "monthly revenue rollup" : over.description,
  };
}

describe("filterMetabaseDashboards", () => {
  test("matches against name (case-insensitive)", () => {
    expect(filterMetabaseDashboards([dashboard({})], { query: "REVENUE" })).toHaveLength(1);
  });

  test("matches against description", () => {
    expect(
      filterMetabaseDashboards([dashboard({ name: "X", description: "payment failures" })], {
        query: "failures",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMetabaseDashboards([dashboard({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterMetabaseDashboards([null, 42, "x", dashboard({})], { query: "revenue" }),
    ).toHaveLength(1);
  });

  test("tolerates a null/missing description without throwing", () => {
    const noDesc = { id: 2, name: "Funnel", description: null };
    expect(filterMetabaseDashboards([noDesc], { query: "funnel" })).toHaveLength(1);
    expect(filterMetabaseDashboards([noDesc], { query: "rollup" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      dashboard({ name: `dash-${String(i)}`, description: "" }),
    );
    expect(filterMetabaseDashboards(many, { query: "dash-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      dashboard({ name: `dash-${String(i)}`, description: "" }),
    );
    expect(filterMetabaseDashboards(many, { query: "dash-" })).toHaveLength(50);
  });
});
