import { describe, expect, test } from "bun:test";

import { filterTableauViews } from "../src/search-filter.ts";

function view(over: { name?: string; luid?: string }): Record<string, unknown> {
  return {
    luid: over.luid ?? "abc-123",
    name: over.name ?? "Sales Overview",
  };
}

describe("filterTableauViews", () => {
  test("matches against name (case-insensitive)", () => {
    expect(filterTableauViews([view({})], { query: "SALES" })).toHaveLength(1);
  });

  test("matches against luid", () => {
    expect(
      filterTableauViews([view({ luid: "def-456", name: "X" })], { query: "def-456" }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterTableauViews([view({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterTableauViews([null, 42, "x", [], [1, 2], view({})], { query: "sales" })).toHaveLength(1);
  });

  test("tolerates a missing name without throwing", () => {
    const noName = { luid: "ghi-789" };
    expect(filterTableauViews([noName], { query: "ghi-789" })).toHaveLength(1);
    expect(filterTableauViews([noName], { query: "rollup" })).toHaveLength(0);
  });

  test("handles non-string values gracefully", () => {
    const nonString = { name: 123, luid: true };
    // Should skip since they aren't matched as strings
    expect(filterTableauViews([nonString], { query: "123" })).toHaveLength(0);
    expect(filterTableauViews([nonString], { query: "true" })).toHaveLength(0);

    // An empty query will match empty strings which is what the non-string values become
    expect(filterTableauViews([nonString], { query: "" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      view({ name: `view-${String(i)}`, luid: `luid-${String(i)}` }),
    );
    expect(filterTableauViews(many, { query: "view-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      view({ name: `view-${String(i)}`, luid: `luid-${String(i)}` }),
    );
    expect(filterTableauViews(many, { query: "view-" })).toHaveLength(50);
  });
});
