import { describe, expect, test } from "bun:test";

import { filterGreenhouseJobs } from "../src/search-filter.ts";

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4001,
    name: "Senior Backend Engineer",
    status: "open",
    requisition_id: "ENG-042",
    confidential: false,
    departments: [{ id: 1, name: "Engineering" }],
    offices: [{ id: 10, name: "San Francisco HQ", location: { name: "San Francisco, CA" } }],
    created_at: "2024-03-01T12:00:00.000Z",
    updated_at: "2024-03-02T12:00:00.000Z",
    ...over,
  };
}

describe("filterGreenhouseJobs", () => {
  test("matches against the job name (case-insensitive)", () => {
    expect(filterGreenhouseJobs([job()], { query: "backend engineer" })).toHaveLength(1);
    expect(filterGreenhouseJobs([job()], { query: "SENIOR" })).toHaveLength(1);
  });

  test("matches against status, requisition_id, department, office name, and office location", () => {
    expect(filterGreenhouseJobs([job()], { query: "open" })).toHaveLength(1);
    expect(filterGreenhouseJobs([job()], { query: "eng-042" })).toHaveLength(1);
    expect(filterGreenhouseJobs([job()], { query: "engineering" })).toHaveLength(1);
    expect(filterGreenhouseJobs([job()], { query: "san francisco hq" })).toHaveLength(1);
    expect(filterGreenhouseJobs([job()], { query: "san francisco, ca" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterGreenhouseJobs([job()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterGreenhouseJobs([null, 42, "x", job()], { query: "engineering" })).toHaveLength(1);
  });

  test("tolerates missing fields and non-object department/office entries", () => {
    const sparse = job();
    delete sparse["status"];
    sparse["departments"] = [null, 7, { name: "Product" }];
    sparse["offices"] = [{ name: "Remote" }];
    expect(filterGreenhouseJobs([sparse], { query: "backend engineer" })).toHaveLength(1);
    expect(filterGreenhouseJobs([sparse], { query: "product" })).toHaveLength(1);
    expect(filterGreenhouseJobs([sparse], { query: "remote" })).toHaveLength(1);
    expect(filterGreenhouseJobs([sparse], { query: "san francisco" })).toHaveLength(0);
  });

  test("tolerates a missing departments / offices array", () => {
    const bare = job();
    delete bare["departments"];
    delete bare["offices"];
    expect(filterGreenhouseJobs([bare], { query: "backend engineer" })).toHaveLength(1);
    expect(filterGreenhouseJobs([bare], { query: "engineering" })).toHaveLength(0);
  });

  test("tolerates a non-array departments field and a missing office location", () => {
    const weird = job({ departments: "nope", offices: [{ name: "Remote", location: "bad" }] });
    expect(filterGreenhouseJobs([weird], { query: "backend engineer" })).toHaveLength(1);
    expect(filterGreenhouseJobs([weird], { query: "engineering" })).toHaveLength(0);
    expect(filterGreenhouseJobs([weird], { query: "remote" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => job({ id: 5000 + i }));
    expect(filterGreenhouseJobs(many, { query: "backend engineer", limit: 3 })).toHaveLength(3);
  });
});
