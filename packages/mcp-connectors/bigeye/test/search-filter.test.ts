import { describe, expect, test } from "bun:test";

import { filterBigeyeIssues } from "../src/search-filter.ts";

function issue(over: {
  summary?: string;
  title?: string | null;
  description?: string | null;
}): Record<string, unknown> {
  return {
    id: "issue-1",
    summary: over.summary ?? "Null rate anomaly detected",
    title: over.title === undefined ? "Data quality alert" : over.title,
    description:
      over.description === undefined ? "Row count dropped below threshold" : over.description,
  };
}

describe("filterBigeyeIssues", () => {
  test("matches against summary (case-insensitive)", () => {
    expect(filterBigeyeIssues([issue({})], { query: "NULL RATE" })).toHaveLength(1);
    expect(filterBigeyeIssues([issue({})], { query: "null rate" })).toHaveLength(1);
  });

  test("matches against title", () => {
    expect(
      filterBigeyeIssues([issue({ title: "Schema drift detected" })], { query: "schema" }),
    ).toHaveLength(1);
  });

  test("matches against description", () => {
    expect(
      filterBigeyeIssues([issue({ description: "Freshness SLA breached" })], {
        query: "freshness",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterBigeyeIssues([issue({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterBigeyeIssues([null, 42, "x", issue({})], { query: "anomaly" })).toHaveLength(1);
  });

  test("tolerates null title/description without throwing", () => {
    const minimal = { id: "2", summary: "Volume drop", title: null, description: null };
    expect(filterBigeyeIssues([minimal], { query: "volume" })).toHaveLength(1);
    expect(filterBigeyeIssues([minimal], { query: "missing" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      issue({ summary: `issue-${String(i)} anomaly` }),
    );
    expect(filterBigeyeIssues(many, { query: "anomaly", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      issue({ summary: `issue-${String(i)} anomaly` }),
    );
    expect(filterBigeyeIssues(many, { query: "anomaly" })).toHaveLength(50);
  });
});
