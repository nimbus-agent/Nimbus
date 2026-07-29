import { describe, expect, test } from "bun:test";

import { filterReadwiseBooks, filterReadwiseHighlights } from "../src/search-filter.ts";

function highlight(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    text: "Exponential backoff with jitter avoids thundering-herd retries",
    note: "Use full jitter for queue workers",
    location: 42,
    location_type: "location",
    color: "yellow",
    book_id: 9001,
    url: "https://example.com/article",
    tags: [
      { id: 1, name: "reliability" },
      { id: 2, name: "retries" },
    ],
    highlighted_at: "2024-03-01T12:00:00.000Z",
    updated: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

describe("filterReadwiseHighlights", () => {
  test("matches against highlight text (case-insensitive)", () => {
    expect(filterReadwiseHighlights([highlight()], { query: "exponential backoff" })).toHaveLength(
      1,
    );
  });

  test("matches against note, color, location_type, and tag names", () => {
    expect(filterReadwiseHighlights([highlight()], { query: "full jitter" })).toHaveLength(1);
    expect(filterReadwiseHighlights([highlight()], { query: "yellow" })).toHaveLength(1);
    expect(filterReadwiseHighlights([highlight()], { query: "location" })).toHaveLength(1);
    expect(filterReadwiseHighlights([highlight()], { query: "reliability" })).toHaveLength(1);
    expect(filterReadwiseHighlights([highlight()], { query: "retries" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterReadwiseHighlights([highlight()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the source url (not in the haystack)", () => {
    expect(filterReadwiseHighlights([highlight()], { query: "example.com" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterReadwiseHighlights([null, 42, "x", highlight()], { query: "reliability" }),
    ).toHaveLength(1);
  });

  test("tolerates missing string fields and non-object tags", () => {
    const sparse = highlight();
    delete sparse["note"];
    delete sparse["color"];
    sparse["tags"] = [null, 7, { id: 3, name: "ops" }];
    expect(filterReadwiseHighlights([sparse], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterReadwiseHighlights([sparse], { query: "ops" })).toHaveLength(1);
    expect(filterReadwiseHighlights([sparse], { query: "full jitter" })).toHaveLength(0);
  });

  test("tolerates a missing tags array", () => {
    const noTags = highlight();
    delete noTags["tags"];
    expect(filterReadwiseHighlights([noTags], { query: "exponential backoff" })).toHaveLength(1);
    expect(filterReadwiseHighlights([noTags], { query: "reliability" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => highlight({ id: i }));
    expect(filterReadwiseHighlights(many, { query: "exponential backoff", limit: 3 })).toHaveLength(
      3,
    );
  });
});

function book(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    title: "Release It! Design and Deploy Production-Ready Software",
    author: "Michael T. Nygard",
    category: "books",
    source: "kindle",
    num_highlights: 42,
    cover_image_url: "https://cover.example.com/nygard.png",
    highlights_url: "https://readwise.io/bookreview/9001",
    source_url: null,
    asin: "B00A32NXZO",
    tags: [
      { id: 1, name: "reliability" },
      { id: 2, name: "retries" },
    ],
    document_note: "the stability-patterns chapters",
    ...over,
  };
}

describe("filterReadwiseBooks", () => {
  test("matches against the title (case-insensitive)", () => {
    expect(filterReadwiseBooks([book()], { query: "release it" })).toHaveLength(1);
  });

  test("matches against author, category, source, document note, and tag names", () => {
    expect(filterReadwiseBooks([book()], { query: "nygard" })).toHaveLength(1);
    expect(filterReadwiseBooks([book()], { query: "books" })).toHaveLength(1);
    expect(filterReadwiseBooks([book()], { query: "kindle" })).toHaveLength(1);
    expect(filterReadwiseBooks([book()], { query: "stability-patterns" })).toHaveLength(1);
    expect(filterReadwiseBooks([book()], { query: "reliability" })).toHaveLength(1);
    expect(filterReadwiseBooks([book()], { query: "retries" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterReadwiseBooks([book()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the cover/highlights urls (not in the haystack)", () => {
    expect(filterReadwiseBooks([book()], { query: "cover.example.com" })).toHaveLength(0);
    expect(filterReadwiseBooks([book()], { query: "bookreview" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterReadwiseBooks([null, 42, "x", book()], { query: "nygard" })).toHaveLength(1);
  });

  test("tolerates missing string fields and non-object tags", () => {
    const sparse = book();
    delete sparse["author"];
    delete sparse["document_note"];
    sparse["tags"] = [null, 7, { id: 3, name: "ops" }];
    expect(filterReadwiseBooks([sparse], { query: "release it" })).toHaveLength(1);
    expect(filterReadwiseBooks([sparse], { query: "ops" })).toHaveLength(1);
    expect(filterReadwiseBooks([sparse], { query: "nygard" })).toHaveLength(0);
  });

  test("tolerates a missing tags array", () => {
    const noTags = book();
    delete noTags["tags"];
    expect(filterReadwiseBooks([noTags], { query: "release it" })).toHaveLength(1);
    expect(filterReadwiseBooks([noTags], { query: "reliability" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => book({ id: i }));
    expect(filterReadwiseBooks(many, { query: "release it", limit: 3 })).toHaveLength(3);
  });
});
