import { describe, expect, test } from "bun:test";

import { filterDagsterJobs } from "../src/search-filter.ts";

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "nightly_etl",
    repository: "analytics",
    location: "analytics_code",
    description: "Nightly extract-transform-load job",
    isJob: true,
    tags: [
      { key: "team", value: "data" },
      { key: "tier", value: "1" },
    ],
    ...over,
  };
}

describe("filterDagsterJobs", () => {
  test("matches against the name (case-insensitive)", () => {
    expect(filterDagsterJobs([job()], { query: "NIGHTLY" })).toHaveLength(1);
  });

  test("matches against repository, location, and description", () => {
    expect(filterDagsterJobs([job()], { query: "analytics" })).toHaveLength(1);
    expect(filterDagsterJobs([job()], { query: "analytics_code" })).toHaveLength(1);
    expect(filterDagsterJobs([job()], { query: "extract-transform" })).toHaveLength(1);
  });

  test("matches against tag keys and values", () => {
    expect(filterDagsterJobs([job()], { query: "team" })).toHaveLength(1);
    expect(filterDagsterJobs([job()], { query: "data" })).toHaveLength(1);
    expect(filterDagsterJobs([job()], { query: "tier" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterDagsterJobs([job()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips entries that are not objectish", () => {
    expect(filterDagsterJobs([null, 42, "x", job()], { query: "nightly" })).toHaveLength(1);
  });

  test("tolerates missing fields and a non-array tags value", () => {
    const sparse = job({ description: undefined, location: undefined, tags: "nope" });
    expect(filterDagsterJobs([sparse], { query: "nightly" })).toHaveLength(1);
    expect(filterDagsterJobs([sparse], { query: "team" })).toHaveLength(0);
  });

  test("tolerates non-objectish tag entries", () => {
    const odd = job({ tags: [null, 7, { key: "ok-tag", value: "" }] });
    expect(filterDagsterJobs([odd], { query: "ok-tag" })).toHaveLength(1);
    expect(filterDagsterJobs([odd], { query: "7" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => job({ name: `nightly_etl_${String(i)}` }));
    expect(filterDagsterJobs(many, { query: "nightly", limit: 3 })).toHaveLength(3);
  });
});
