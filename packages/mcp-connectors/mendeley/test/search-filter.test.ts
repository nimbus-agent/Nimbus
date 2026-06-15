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

  test("tolerates author object with neither first_name nor last_name", () => {
    // Start from a baseline whose ONLY occurrence of the needle is in an author,
    // then add an author with neither first_name nor last_name.
    const baseline = doc({ authors: [{ first_name: "zzqauthor" }] });
    expect(filterMendeleyDocuments([baseline], { query: "zzqauthor" })).toHaveLength(1);

    // Now remove the named author and replace with one that has neither field
    const sparse = doc({ authors: [{ affiliation: "MIT" }] });
    expect(filterMendeleyDocuments([sparse], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterMendeleyDocuments([sparse], { query: "zzqauthor" })).toHaveLength(0);
  });

  test("tolerates empty string in author first_name or last_name", () => {
    const withEmptyField = doc({
      authors: [{ first_name: "", last_name: "Knuth" }],
    });
    // The empty first_name should be filtered out, only "Knuth" remains
    expect(filterMendeleyDocuments([withEmptyField], { query: "Knuth" })).toHaveLength(1);
  });

  test("filters out non-string values in keywords array", () => {
    const withNonStringKeywords = doc({
      keywords: [null, 7, "zzqkeyword", undefined, true, "sorting"],
    });
    // Only "zzqkeyword" and "sorting" should be included, non-strings filtered out
    expect(filterMendeleyDocuments([withNonStringKeywords], { query: "zzqkeyword" })).toHaveLength(
      1,
    );
    expect(filterMendeleyDocuments([withNonStringKeywords], { query: "sorting" })).toHaveLength(1);
    // Verify the non-string 7 is not included
    expect(
      filterMendeleyDocuments([doc({ keywords: [7] })], { query: "exponential backoff" }),
    ).toHaveLength(1);
  });

  test("tolerates missing identifiers object for DOI extraction", () => {
    // Start from a baseline that can be found only via DOI, then remove identifiers.
    const withDoi = doc({ identifiers: { doi: "zzqdoi123" } });
    expect(filterMendeleyDocuments([withDoi], { query: "zzqdoi123" })).toHaveLength(1);

    // Now test without identifiers
    const noDoi = doc({ identifiers: undefined });
    expect(filterMendeleyDocuments([noDoi], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterMendeleyDocuments([noDoi], { query: "zzqdoi123" })).toHaveLength(0);

    // Also test with non-object identifiers
    const invalidDoi = doc({ identifiers: "not-an-object" });
    expect(filterMendeleyDocuments([invalidDoi], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterMendeleyDocuments([invalidDoi], { query: "zzqdoi123" })).toHaveLength(0);
  });
});
