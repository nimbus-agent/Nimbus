import { describe, expect, test } from "bun:test";

import { filterZoteroItems } from "../src/search-filter.ts";

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { data: dataOver, ...rootOver } = over;
  return {
    key: "ABCD1234",
    version: 100,
    library: { type: "user", id: 12345 },
    ...rootOver,
    data: {
      key: "ABCD1234",
      itemType: "journalArticle",
      title: "Exponential backoff with jitter avoids thundering-herd retries",
      abstractNote: "A study of full-jitter retry strategies for distributed queues.",
      DOI: "10.1145/1234567.8901234",
      publicationTitle: "Journal of Reliability Engineering",
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "author", firstName: "Grace", lastName: "Hopper" },
      ],
      tags: [{ tag: "reliability" }, { tag: "retries" }],
      collections: ["COLL01"],
      date: "2024",
      dateModified: "2024-03-02T08:00:00Z",
      dateAdded: "2024-03-01T12:00:00Z",
      ...dataOver,
    },
  };
}

describe("filterZoteroItems", () => {
  test("matches against the title (case-insensitive)", () => {
    expect(filterZoteroItems([item()], { query: "exponential backoff" })).toHaveLength(1);
  });

  test("matches against item type, abstract, DOI, publication title, creators, and tags", () => {
    expect(filterZoteroItems([item()], { query: "journalArticle" })).toHaveLength(1);
    expect(filterZoteroItems([item()], { query: "full-jitter" })).toHaveLength(1);
    expect(filterZoteroItems([item()], { query: "10.1145/1234567" })).toHaveLength(1);
    expect(filterZoteroItems([item()], { query: "Reliability Engineering" })).toHaveLength(1);
    expect(filterZoteroItems([item()], { query: "Ada Lovelace" })).toHaveLength(1);
    expect(filterZoteroItems([item()], { query: "Grace Hopper" })).toHaveLength(1);
    expect(filterZoteroItems([item()], { query: "retries" })).toHaveLength(1);
  });

  test("supports the single-field `name` creator shape", () => {
    const org = item({ data: { creators: [{ creatorType: "author", name: "ACME Corp" }] } });
    expect(filterZoteroItems([org], { query: "ACME Corp" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterZoteroItems([item()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips entries without an objectish `data`", () => {
    expect(
      filterZoteroItems([null, 42, "x", { key: "no-data" }, item()], { query: "retries" }),
    ).toHaveLength(1);
  });

  test("tolerates missing string fields and non-object creators/tags", () => {
    const sparse = item({
      data: {
        abstractNote: undefined,
        DOI: undefined,
        creators: [null, 7, { creatorType: "author", lastName: "Knuth" }],
        tags: [null, 7, { tag: "algorithms" }],
      },
    });
    expect(filterZoteroItems([sparse], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterZoteroItems([sparse], { query: "Knuth" })).toHaveLength(1);
    expect(filterZoteroItems([sparse], { query: "algorithms" })).toHaveLength(1);
    expect(filterZoteroItems([sparse], { query: "full-jitter" })).toHaveLength(0);
  });

  test("tolerates a missing tags / creators array", () => {
    // Start from a baseline whose ONLY occurrence of these needles is the
    // tags / creators arrays, then remove those arrays.
    const tagged = item({ data: { tags: [{ tag: "zzqtag" }], creators: [{ name: "zzqauthor" }] } });
    expect(filterZoteroItems([tagged], { query: "zzqtag" })).toHaveLength(1);
    expect(filterZoteroItems([tagged], { query: "zzqauthor" })).toHaveLength(1);

    const bare = item({ data: { tags: undefined, creators: undefined } });
    expect(filterZoteroItems([bare], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterZoteroItems([bare], { query: "zzqtag" })).toHaveLength(0);
    expect(filterZoteroItems([bare], { query: "zzqauthor" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ key: `K${String(i)}` }));
    expect(filterZoteroItems(many, { query: "exponential backoff", limit: 3 })).toHaveLength(3);
  });

  test("supports creators with only firstName or only lastName", () => {
    const onlyFirst = item({ data: { creators: [{ creatorType: "author", firstName: "Cher" }] } });
    const onlyLast = item({ data: { creators: [{ creatorType: "author", lastName: "Prince" }] } });

    expect(filterZoteroItems([onlyFirst], { query: "Cher" })).toHaveLength(1);
    expect(filterZoteroItems([onlyLast], { query: "Prince" })).toHaveLength(1);
  });

  test("ignores tag when it is not a string", () => {
    // The previous item() has a baseline title of "Exponential backoff..."
    // so if we search for "12345", it might match DOI which is "10.1145/1234567.8901234"
    // We should clear DOI to ensure we are only testing the tag filter.
    const badTag = item({ data: { DOI: undefined, tags: [{ tag: 12345 }] } });
    expect(filterZoteroItems([badTag], { query: "12345" })).toHaveLength(0);
  });
});
