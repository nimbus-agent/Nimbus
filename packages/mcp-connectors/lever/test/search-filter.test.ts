import { describe, expect, test } from "bun:test";

import { filterLeverPostings } from "../src/search-filter.ts";

function posting(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f2f01e16-27f8-4711-a728-e7c5e8c2d4c4",
    text: "Senior Backend Engineer",
    state: "published",
    categories: {
      team: "Engineering",
      department: "Product",
      location: "Remote",
      commitment: "Full-time",
      level: "Senior",
    },
    tags: ["backend", "golang"],
    hostedUrl: "https://jobs.lever.co/acme/f2f01e16",
    applyUrl: "https://jobs.lever.co/acme/f2f01e16/apply",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    ...over,
  };
}

describe("filterLeverPostings", () => {
  test("matches against posting text/title (case-insensitive)", () => {
    expect(filterLeverPostings([posting()], { query: "backend engineer" })).toHaveLength(1);
    expect(filterLeverPostings([posting()], { query: "SENIOR" })).toHaveLength(1);
  });

  test("matches against state, team, department, location, and tags", () => {
    expect(filterLeverPostings([posting()], { query: "published" })).toHaveLength(1);
    expect(filterLeverPostings([posting()], { query: "engineering" })).toHaveLength(1);
    expect(filterLeverPostings([posting()], { query: "product" })).toHaveLength(1);
    expect(filterLeverPostings([posting()], { query: "remote" })).toHaveLength(1);
    expect(filterLeverPostings([posting()], { query: "golang" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterLeverPostings([posting()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the hostedUrl (not in the haystack)", () => {
    expect(filterLeverPostings([posting()], { query: "jobs.lever.co" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterLeverPostings([null, 42, "x", posting()], { query: "engineering" })).toHaveLength(
      1,
    );
  });

  test("tolerates missing fields and non-string tags", () => {
    const sparse = posting();
    delete sparse["state"];
    sparse["categories"] = { team: "Engineering" };
    sparse["tags"] = [null, 7, "ops"];
    expect(filterLeverPostings([sparse], { query: "backend engineer" })).toHaveLength(1);
    expect(filterLeverPostings([sparse], { query: "ops" })).toHaveLength(1);
    expect(filterLeverPostings([sparse], { query: "remote" })).toHaveLength(0);
  });

  test("tolerates a missing categories object and a missing tags array", () => {
    const bare = posting();
    delete bare["categories"];
    delete bare["tags"];
    expect(filterLeverPostings([bare], { query: "backend engineer" })).toHaveLength(1);
    expect(filterLeverPostings([bare], { query: "engineering" })).toHaveLength(0);
  });

  test("tolerates a non-object categories field", () => {
    const weird = posting({ categories: "nope" });
    expect(filterLeverPostings([weird], { query: "backend engineer" })).toHaveLength(1);
    expect(filterLeverPostings([weird], { query: "engineering" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => posting({ id: `id-${String(i)}` }));
    expect(filterLeverPostings(many, { query: "backend engineer", limit: 3 })).toHaveLength(3);
  });
});
