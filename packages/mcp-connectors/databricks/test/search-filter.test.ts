import { describe, expect, test } from "bun:test";

import { filterDatabricksJobs } from "../src/search-filter.ts";

function job(over: {
  name?: string | null;
  creator?: string;
  job_id?: number;
}): Record<string, unknown> {
  return {
    job_id: over.job_id ?? 1,
    creator_user_name: over.creator ?? "alice@acme.com",
    settings: {
      name: over.name === undefined ? "Nightly ETL" : over.name,
    },
  };
}

describe("filterDatabricksJobs", () => {
  test("matches against settings.name (case-insensitive)", () => {
    expect(filterDatabricksJobs([job({})], { query: "NIGHTLY" })).toHaveLength(1);
  });

  test("matches against creator_user_name", () => {
    expect(
      filterDatabricksJobs([job({ name: "X", creator: "bob@acme.com" })], { query: "bob" }),
    ).toHaveLength(1);
  });

  test("matches against job_id", () => {
    expect(filterDatabricksJobs([job({ job_id: 98765 })], { query: "98765" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterDatabricksJobs([job({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterDatabricksJobs([null, 42, "x", job({})], { query: "nightly" })).toHaveLength(1);
  });

  test("tolerates a missing settings object without throwing", () => {
    const noSettings = { job_id: 2, creator_user_name: "carol@acme.com" };
    expect(filterDatabricksJobs([noSettings], { query: "carol" })).toHaveLength(1);
    expect(filterDatabricksJobs([noSettings], { query: "nightly" })).toHaveLength(0);
  });

  test("tolerates a null settings.name", () => {
    const nullName = { job_id: 3, creator_user_name: "dan@acme.com", settings: { name: null } };
    expect(filterDatabricksJobs([nullName], { query: "dan" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => job({ name: `dash-${String(i)}` }));
    expect(filterDatabricksJobs(many, { query: "dash-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => job({ name: `dash-${String(i)}` }));
    expect(filterDatabricksJobs(many, { query: "dash-" })).toHaveLength(50);
  });
});
