import { describe, expect, test } from "bun:test";

import { filterSupersetDashboards } from "../src/search-filter.ts";

function dashboard(over: {
  dashboard_title?: string;
  slug?: string | null;
}): Record<string, unknown> {
  return {
    id: 1,
    dashboard_title: over.dashboard_title ?? "Revenue Overview",
    slug: over.slug === undefined ? "revenue-overview" : over.slug,
  };
}

describe("filterSupersetDashboards", () => {
  test("matches against dashboard_title (case-insensitive)", () => {
    expect(filterSupersetDashboards([dashboard({})], { query: "REVENUE" })).toHaveLength(1);
  });

  test("matches against slug", () => {
    expect(
      filterSupersetDashboards([dashboard({ dashboard_title: "X", slug: "payment-failures" })], {
        query: "failures",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterSupersetDashboards([dashboard({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterSupersetDashboards([null, 42, "x", dashboard({})], { query: "revenue" }),
    ).toHaveLength(1);
  });

  test("tolerates a null/missing slug without throwing", () => {
    const noSlug = { id: 2, dashboard_title: "Funnel", slug: null };
    expect(filterSupersetDashboards([noSlug], { query: "funnel" })).toHaveLength(1);
    expect(filterSupersetDashboards([noSlug], { query: "revenue" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      dashboard({ dashboard_title: `dash-${String(i)}`, slug: "" }),
    );
    expect(filterSupersetDashboards(many, { query: "dash-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      dashboard({ dashboard_title: `dash-${String(i)}`, slug: "" }),
    );
    expect(filterSupersetDashboards(many, { query: "dash-" })).toHaveLength(50);
  });
});
