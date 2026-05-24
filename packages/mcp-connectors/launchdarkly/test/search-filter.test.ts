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
});
