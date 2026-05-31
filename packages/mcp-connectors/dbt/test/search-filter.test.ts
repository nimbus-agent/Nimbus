import { describe, expect, test } from "bun:test";

import { filterDbtJobs } from "../src/search-filter.ts";

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1234,
    name: "nightly-prod-run",
    dbt_version: "1.7.4",
    ...over,
  };
}

describe("filterDbtJobs", () => {
  test("matches against name (case-insensitive)", () => {
    expect(filterDbtJobs([job()], { query: "NIGHTLY" })).toHaveLength(1);
  });

  test("matches against dbt_version", () => {
    expect(filterDbtJobs([job()], { query: "1.7" })).toHaveLength(1);
  });

  test("matches against the stringified id", () => {
    expect(filterDbtJobs([job()], { query: "1234" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterDbtJobs([job()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterDbtJobs([null, 42, "x", job()], { query: "nightly" })).toHaveLength(1);
  });

  test("tolerates a missing dbt_version without throwing", () => {
    const noVersion = job();
    delete (noVersion as Record<string, unknown>)["dbt_version"];
    expect(filterDbtJobs([noVersion], { query: "nightly" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => job({ name: `job-${String(i)}` }));
    expect(filterDbtJobs(many, { query: "job-", limit: 3 })).toHaveLength(3);
  });
});
