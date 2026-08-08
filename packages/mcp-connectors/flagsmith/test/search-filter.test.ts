import { describe, expect, test } from "bun:test";

import { filterFlagsmithFeatures } from "../src/search-filter.ts";

function feature(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "enable-new-checkout",
    description: "Rolls out the redesigned checkout flow.",
    tags: [1, 2],
    ...over,
  };
}

describe("filterFlagsmithFeatures", () => {
  test("matches against name (case-insensitive)", () => {
    const out = filterFlagsmithFeatures([feature()], { query: "CHECKOUT" });
    expect(out).toHaveLength(1);
  });

  test("matches against description", () => {
    expect(filterFlagsmithFeatures([feature()], { query: "redesigned" })).toHaveLength(1);
  });

  test("matches against stringified tag ids", () => {
    expect(
      filterFlagsmithFeatures([feature({ tags: ["frontend"] })], { query: "frontend" }),
    ).toHaveLength(1);
    expect(filterFlagsmithFeatures([feature()], { query: "2" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterFlagsmithFeatures([feature()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterFlagsmithFeatures([null, 42, "x", feature()], { query: "checkout" })).toHaveLength(
      1,
    );
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => feature({ name: `flag-${String(i)}` }));
    expect(filterFlagsmithFeatures(many, { query: "flag-", limit: 3 })).toHaveLength(3);
  });

  test("handles missing or non-array tags gracefully", () => {
    expect(
      filterFlagsmithFeatures([feature({ name: "checkout", tags: undefined })], {
        query: "checkout",
      }),
    ).toHaveLength(1);
    expect(
      filterFlagsmithFeatures([feature({ name: "checkout", tags: "not-an-array" as never })], {
        query: "checkout",
      }),
    ).toHaveLength(1);
    expect(
      filterFlagsmithFeatures([feature({ name: "checkout", tags: "not-an-array" as never })], {
        query: "not-an-array",
      }),
    ).toHaveLength(0);
  });

  test("ignores invalid tag types", () => {
    const featureWithInvalidTags = feature({
      name: "valid-feature",
      tags: [1, "valid", null, undefined, { key: "value" }, [1, 2, 3]],
    });
    expect(filterFlagsmithFeatures([featureWithInvalidTags], { query: "valid" })).toHaveLength(1);
    expect(filterFlagsmithFeatures([featureWithInvalidTags], { query: "1" })).toHaveLength(1);
    expect(filterFlagsmithFeatures([featureWithInvalidTags], { query: "null" })).toHaveLength(0);
    expect(filterFlagsmithFeatures([featureWithInvalidTags], { query: "undefined" })).toHaveLength(
      0,
    );
    expect(filterFlagsmithFeatures([featureWithInvalidTags], { query: "object" })).toHaveLength(0);
  });

  test("handles missing name and description gracefully", () => {
    const incompleteFeature = { tags: [42] };
    expect(filterFlagsmithFeatures([incompleteFeature], { query: "42" })).toHaveLength(1);
    expect(filterFlagsmithFeatures([incompleteFeature], { query: "checkout" })).toHaveLength(0);
  });
});
