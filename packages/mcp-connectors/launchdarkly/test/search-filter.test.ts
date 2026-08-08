import { describe, expect, test } from "bun:test";

import { filterLaunchDarklyFlags } from "../src/search-filter.ts";

function flag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "enable-new-checkout",
    name: "Enable new checkout",
    description: "Rolls out the redesigned checkout flow.",
    tags: ["checkout", "frontend"],
    ...over,
  };
}

describe("filterLaunchDarklyFlags", () => {
  test("matches against name (case-insensitive)", () => {
    const out = filterLaunchDarklyFlags([flag()], { query: "CHECKOUT" });
    expect(out).toHaveLength(1);
  });

  test("matches against key, description, and tags", () => {
    expect(filterLaunchDarklyFlags([flag()], { query: "enable-new" })).toHaveLength(1);
    expect(filterLaunchDarklyFlags([flag()], { query: "redesigned" })).toHaveLength(1);
    expect(filterLaunchDarklyFlags([flag()], { query: "frontend" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterLaunchDarklyFlags([flag()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterLaunchDarklyFlags([null, 42, "x", flag()], { query: "checkout" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => flag({ key: `flag-${String(i)}` }));
    expect(filterLaunchDarklyFlags(many, { query: "Enable new", limit: 3 })).toHaveLength(3);
  });

  test("tags is not an array — tagsString returns empty string, match still works on other fields", () => {
    // tags is a string, not an array → tagsString returns "" (covers the !Array.isArray branch)
    // Use a flag whose key/name/description don't contain "frontend" so we can confirm the tag is ignored
    const f = flag({
      key: "my-flag",
      name: "My Flag",
      description: "A flag.",
      tags: "not-an-array",
    });
    // name still matches
    expect(filterLaunchDarklyFlags([f], { query: "my flag" })).toHaveLength(1);
    // "frontend" was in the original tags array value that is now a non-array string "not-an-array"
    // but tagsString ignores non-arrays, so the tag text is empty; "not-an-array" won't match "frontend"
    expect(filterLaunchDarklyFlags([f], { query: "frontend" })).toHaveLength(0);
  });

  test("tags is null — tagsString returns empty string", () => {
    // null is not an array → tagsString returns ""
    const f = flag({ tags: null });
    expect(filterLaunchDarklyFlags([f], { query: "redesigned" })).toHaveLength(1);
    expect(filterLaunchDarklyFlags([f], { query: "frontend" })).toHaveLength(0);
  });

  test("tags array contains non-string elements — they are filtered out", () => {
    // mixed array: only string elements should contribute to the match
    // covers the typeof t === "string" false branch inside tagsString
    const f = flag({ tags: [42, null, true, "backend"] });
    // "backend" string tag still matches
    expect(filterLaunchDarklyFlags([f], { query: "backend" })).toHaveLength(1);
    // non-string values (42 → "42") are NOT joined in — so "42" does NOT match
    expect(filterLaunchDarklyFlags([f], { query: "42" })).toHaveLength(0);
    // "null" string does not appear
    expect(filterLaunchDarklyFlags([f], { query: "null" })).toHaveLength(0);
  });

  test("tags array with only non-string elements yields empty tags text", () => {
    // all non-string → tagsString returns ""
    const f = flag({ tags: [1, 2, 3] });
    expect(filterLaunchDarklyFlags([f], { query: "1" })).toHaveLength(0);
    // name still matches
    expect(filterLaunchDarklyFlags([f], { query: "Enable new" })).toHaveLength(1);
  });

  test("missing key field — stringField returns empty string", () => {
    const f: Record<string, unknown> = {
      name: "Enable new checkout",
      description: "Rolls out the redesigned checkout flow.",
      tags: ["checkout"],
    };
    // matches on name
    expect(filterLaunchDarklyFlags([f], { query: "Enable new" })).toHaveLength(1);
    // key-specific query returns no match (key is "")
    expect(filterLaunchDarklyFlags([f], { query: "enable-new-checkout" })).toHaveLength(0);
  });

  test("missing name and description fields — stringField returns empty string for both", () => {
    const f: Record<string, unknown> = {
      key: "my-flag",
      tags: ["my-tag"],
    };
    // matches on key
    expect(filterLaunchDarklyFlags([f], { query: "my-flag" })).toHaveLength(1);
    // matches on tag
    expect(filterLaunchDarklyFlags([f], { query: "my-tag" })).toHaveLength(1);
    // name query returns nothing
    expect(filterLaunchDarklyFlags([f], { query: "Enable new" })).toHaveLength(0);
  });

  test("non-string key field — stringField returns empty string", () => {
    const f = flag({ key: 99 });
    // key is a number, not a string → stringField returns ""
    // should not match on "99"
    expect(filterLaunchDarklyFlags([f], { query: "99" })).toHaveLength(0);
    // still matches on name
    expect(filterLaunchDarklyFlags([f], { query: "Enable new" })).toHaveLength(1);
  });

  test("uses default limit of 50 when limit is undefined", () => {
    const many = Array.from({ length: 60 }, (_, i) => flag({ key: `flag-${String(i)}` }));
    expect(filterLaunchDarklyFlags(many, { query: "Enable new" })).toHaveLength(50);
  });

  test("empty tags array yields empty tags text", () => {
    const f = flag({ tags: [] });
    // name still matches
    expect(filterLaunchDarklyFlags([f], { query: "Enable new" })).toHaveLength(1);
    expect(filterLaunchDarklyFlags([f], { query: "frontend" })).toHaveLength(0);
  });

  test("does not match against unrelated properties", () => {
    const f = flag({ unrelatedField: "secret-search-term" });
    // search for the unrelated term should yield no results
    expect(filterLaunchDarklyFlags([f], { query: "secret-search-term" })).toHaveLength(0);
  });

  test("empty input list returns empty output list", () => {
    expect(filterLaunchDarklyFlags([], { query: "anything" })).toHaveLength(0);
  });
});
