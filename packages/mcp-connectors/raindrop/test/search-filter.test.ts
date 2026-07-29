import { describe, expect, test } from "bun:test";

import { filterRaindropBookmarks, filterRaindropCollections } from "../src/search-filter.ts";

function bookmark(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 123456,
    title: "Exponential backoff with jitter avoids thundering-herd retries",
    excerpt: "A clear explanation of full jitter for queue workers",
    note: "Use full jitter for queue workers",
    link: "https://example.com/article",
    domain: "example.com",
    type: "article",
    tags: ["reliability", "retries"],
    cover: "https://example.com/cover.png",
    collectionId: 9001,
    created: "2024-03-01T12:00:00.000Z",
    lastUpdate: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

describe("filterRaindropBookmarks", () => {
  test("matches against bookmark title (case-insensitive)", () => {
    expect(filterRaindropBookmarks([bookmark()], { query: "exponential backoff" })).toHaveLength(1);
  });

  test("matches against excerpt, note, domain, link, type, and tags", () => {
    expect(filterRaindropBookmarks([bookmark()], { query: "full jitter" })).toHaveLength(1);
    expect(filterRaindropBookmarks([bookmark()], { query: "example.com" })).toHaveLength(1);
    expect(filterRaindropBookmarks([bookmark()], { query: "/article" })).toHaveLength(1);
    expect(filterRaindropBookmarks([bookmark()], { query: "article" })).toHaveLength(1);
    expect(filterRaindropBookmarks([bookmark()], { query: "reliability" })).toHaveLength(1);
    expect(filterRaindropBookmarks([bookmark()], { query: "retries" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterRaindropBookmarks([bookmark()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the cover url (not in the haystack)", () => {
    expect(filterRaindropBookmarks([bookmark()], { query: "cover.png" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterRaindropBookmarks([null, 42, "x", bookmark()], { query: "reliability" }),
    ).toHaveLength(1);
  });

  test("tolerates missing string fields and non-string tags", () => {
    const sparse = bookmark();
    delete sparse["note"];
    delete sparse["excerpt"];
    sparse["tags"] = [null, 7, "ops"];
    expect(filterRaindropBookmarks([sparse], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterRaindropBookmarks([sparse], { query: "ops" })).toHaveLength(1);
    expect(filterRaindropBookmarks([sparse], { query: "full jitter" })).toHaveLength(0);
  });

  test("tolerates a missing tags array", () => {
    const noTags = bookmark();
    delete noTags["tags"];
    expect(filterRaindropBookmarks([noTags], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterRaindropBookmarks([noTags], { query: "reliability" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => bookmark({ _id: i }));
    expect(filterRaindropBookmarks(many, { query: "exponential backoff", limit: 3 })).toHaveLength(
      3,
    );
  });
});

function collection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 9001,
    title: "Distributed systems reading",
    count: 137,
    public: false,
    view: "masonry",
    color: "#0N0N0N",
    sort: -1,
    cover: ["https://cover.example.com/shelf.png"],
    access: { level: 4, draggable: true },
    created: "2024-03-01T12:00:00.000Z",
    lastUpdate: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

describe("filterRaindropCollections", () => {
  test("matches against the collection title (case-insensitive)", () => {
    expect(filterRaindropCollections([collection()], { query: "DISTRIBUTED" })).toHaveLength(1);
  });

  test("matches against view and color", () => {
    expect(filterRaindropCollections([collection()], { query: "masonry" })).toHaveLength(1);
    expect(filterRaindropCollections([collection()], { query: "#0n0n0n" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterRaindropCollections([collection()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the cover url (not in the haystack)", () => {
    expect(filterRaindropCollections([collection()], { query: "shelf.png" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterRaindropCollections([null, 42, "x", collection()], { query: "distributed" }),
    ).toHaveLength(1);
  });

  test("tolerates missing string fields", () => {
    const sparse = collection();
    delete sparse["view"];
    delete sparse["color"];
    expect(filterRaindropCollections([sparse], { query: "distributed" })).toHaveLength(1);
    expect(filterRaindropCollections([sparse], { query: "masonry" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => collection({ _id: i }));
    expect(filterRaindropCollections(many, { query: "distributed", limit: 3 })).toHaveLength(3);
  });
});
