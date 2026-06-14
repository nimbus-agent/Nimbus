import { describe, expect, test } from "bun:test";
import { filterMendeleyDocuments } from "../src/search-filter.ts";

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc-1",
    title: "Exponential backoff with jitter avoids thundering-herd retries",
    type: "journal",
    abstract: "A study of full-jitter retry strategies for distributed queues.",
    year: 2024,
    source: "Journal of Reliability Engineering",
    identifiers: { doi: "10.1145/1234567.8901234" },
    authors: [
      { first_name: "Ada", last_name: "Lovelace" },
      { first_name: "Grace", last_name: "Hopper" },
    ],
    keywords: ["reliability", "retries"],
    last_modified: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

describe("filterMendeleyDocuments", () => {
  test("matches title, type, abstract, doi, source, authors, keywords (case-insensitive)", () => {
    expect(filterMendeleyDocuments([doc()], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "journal" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "full-jitter" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "10.1145/1234567" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "Reliability Engineering" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "Ada Lovelace" })).toHaveLength(1);
    expect(filterMendeleyDocuments([doc()], { query: "retries" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMendeleyDocuments([doc()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries and tolerates missing fields", () => {
    const sparse = doc({
      abstract: undefined,
      identifiers: undefined,
      authors: [null, 7],
      keywords: undefined,
    });
    expect(
      filterMendeleyDocuments([null, 42, "x", sparse], { query: "exponential backoff" }),
    ).toHaveLength(1);
    expect(filterMendeleyDocuments([sparse], { query: "full-jitter" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => doc({ id: `d${String(i)}` }));
    expect(filterMendeleyDocuments(many, { query: "exponential backoff", limit: 3 })).toHaveLength(
      3,
    );
  });
});
