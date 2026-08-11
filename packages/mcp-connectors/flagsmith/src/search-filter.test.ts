import { describe, expect, test } from "bun:test";
import { filterFlagsmithFeatures } from "./search-filter.ts";

describe("filterFlagsmithFeatures", () => {
  const features = [
    { name: "feature_one", description: "First feature", tags: ["frontend", 1, null] },
    { name: "feature_two", description: "Second feature", tags: ["backend", 2] },
    { name: "feature_three", description: null, tags: "not-an-array" },
    { name: "feature_four", description: "Fourth feature" },
    "not-an-object",
  ];

  // One assertion shape over the fields the filter searches. Named per case so a
  // failure still says WHICH field stopped matching, which is the only thing the
  // separate copies bought.
  test.each([
    ["name", "feature_one", "feature_one"],
    ["description", "second", "feature_two"],
    ["string tags", "frontend", "feature_one"],
  ])("matches by %s", (_field, query, expected) => {
    const result = filterFlagsmithFeatures(features, { query });
    expect(result).toHaveLength(1);
    expect((result[0] as { name?: string }).name).toBe(expected);
  });

  test("matches by number tags", () => {
    const result = filterFlagsmithFeatures(features, { query: "2" });
    expect(result).toHaveLength(1);
    expect((result[0] as { name?: string }).name).toBe("feature_two");
  });

  test("ignores non-string/non-number items in tags array", () => {
    const result = filterFlagsmithFeatures(features, { query: "null" });
    expect(result).toHaveLength(0); // "null" is passed in `tags` for feature_one, but should be ignored
  });

  test("handles missing or non-array tags without throwing", () => {
    const result = filterFlagsmithFeatures(features, { query: "feature_three" });
    expect(result).toHaveLength(1);
    expect((result[0] as { name?: string }).name).toBe("feature_three");
  });

  test("handles non-object items gracefully", () => {
    const result = filterFlagsmithFeatures(features, { query: "not-an-object" });
    expect(result).toHaveLength(0);
  });

  test("honors the limit option", () => {
    const result = filterFlagsmithFeatures(features, { query: "feature", limit: 2 });
    expect(result).toHaveLength(2);
  });
});
