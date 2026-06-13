import { describe, expect, test } from "bun:test";

import { filterPowerBiReports } from "../src/search-filter.ts";

function report(over: {
  id?: string;
  name?: string;
  description?: string | null;
}): Record<string, unknown> {
  return {
    id: over.id ?? "a1b2c3d4-0000-0000-0000-000000000001",
    name: over.name ?? "Revenue Overview",
    description: over.description === undefined ? "monthly revenue rollup" : over.description,
  };
}

describe("filterPowerBiReports", () => {
  test("matches against name (case-insensitive)", () => {
    expect(filterPowerBiReports([report({})], { query: "REVENUE" })).toHaveLength(1);
  });

  test("matches against description", () => {
    expect(
      filterPowerBiReports([report({ name: "Sales", description: "quarterly breakdown" })], {
        query: "quarterly",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterPowerBiReports([report({})], { query: "nonexistent" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterPowerBiReports([null, 42, "x", report({})], { query: "revenue" })).toHaveLength(1);
  });

  test("tolerates a null/missing description without throwing", () => {
    const noDesc = { id: "abc", name: "Funnel", description: null };
    expect(filterPowerBiReports([noDesc], { query: "funnel" })).toHaveLength(1);
    expect(filterPowerBiReports([noDesc], { query: "rollup" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      report({ name: `report-${String(i)}`, description: "" }),
    );
    expect(filterPowerBiReports(many, { query: "report-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      report({ name: `report-${String(i)}`, description: "" }),
    );
    expect(filterPowerBiReports(many, { query: "report-" })).toHaveLength(50);
  });
});
