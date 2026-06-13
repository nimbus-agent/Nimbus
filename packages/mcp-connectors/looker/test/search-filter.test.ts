import { describe, expect, test } from "bun:test";

import { filterLookerDashboards } from "../src/search-filter.ts";

function dashboard(over: { title?: string; id?: string }): Record<string, unknown> {
  return {
    id: over.id ?? "42",
    title: over.title ?? "Revenue Overview",
  };
}

describe("filterLookerDashboards", () => {
  test("matches against title (case-insensitive)", () => {
    expect(filterLookerDashboards([dashboard({})], { query: "REVENUE" })).toHaveLength(1);
  });

  test("matches against id", () => {
    expect(
      filterLookerDashboards([dashboard({ id: "99", title: "X" })], { query: "99" }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterLookerDashboards([dashboard({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterLookerDashboards([null, 42, "x", dashboard({})], { query: "revenue" }),
    ).toHaveLength(1);
  });

  test("tolerates a missing title without throwing", () => {
    const noTitle = { id: "7" };
    expect(filterLookerDashboards([noTitle], { query: "7" })).toHaveLength(1);
    expect(filterLookerDashboards([noTitle], { query: "rollup" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      dashboard({ title: `dash-${String(i)}`, id: String(i) }),
    );
    expect(filterLookerDashboards(many, { query: "dash-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      dashboard({ title: `dash-${String(i)}`, id: String(i) }),
    );
    expect(filterLookerDashboards(many, { query: "dash-" })).toHaveLength(50);
  });
});
