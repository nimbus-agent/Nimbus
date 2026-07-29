import { describe, expect, test } from "bun:test";

import { mapReadwiseBookToItem } from "../../../src/connectors/readwise-book-mapping.ts";
import { mapReadwiseHighlightToItem } from "../../../src/connectors/readwise-highlight-mapping.ts";
import { itemPrimaryKey } from "../../../src/index/item-key.ts";

const LAST_HIGHLIGHT_ISO = "2024-03-01T12:00:00.000Z";
const LAST_HIGHLIGHT_MS = Date.parse(LAST_HIGHLIGHT_ISO);
const UPDATED_ISO = "2024-03-02T08:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED_ISO);

function makeBook(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    title: "Release It! Design and Deploy Production-Ready Software",
    author: "Michael T. Nygard",
    category: "books",
    source: "kindle",
    num_highlights: 42,
    last_highlight_at: LAST_HIGHLIGHT_ISO,
    updated: UPDATED_ISO,
    cover_image_url: "https://example.com/cover.png",
    highlights_url: "https://readwise.io/bookreview/9001",
    source_url: "https://example.com/article",
    asin: "B00A32NXZO",
    tags: [
      { id: 1, name: "reliability" },
      { id: 2, name: "retries" },
    ],
    document_note: "The stability-patterns chapters are the ones worth re-reading",
    resurface_weighting: 1.5,
    source_syncs_all_books_together: false,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapReadwiseBookToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapReadwiseBookToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseBookToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseBookToItem(42, { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseBookToItem([makeBook()], { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or not a number", () => {
    const noId = makeBook();
    delete noId["id"];
    expect(mapReadwiseBookToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseBookToItem(makeBook({ id: "9001" }), { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseBookToItem(makeBook({ id: Number.NaN }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is `book/<numeric id>`", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("readwise");
    expect(row.type).toBe("book");
    expect(row.externalId).toBe("book/9001");
  });

  test("the `book/` prefix keeps a book distinct from a highlight sharing the numeric id", () => {
    // Readwise numbers books and highlights in SEPARATE sequences, so highlight
    // 9001 and book 9001 both exist. `itemPrimaryKey` is `<service>:<externalId>`
    // and the item table upserts ON CONFLICT(id) — an unprefixed book externalId
    // would silently overwrite the highlight row (and vice versa) on every sync.
    const book = mapReadwiseBookToItem(makeBook({ id: 9001 }), { syncedAt: NOW });
    const highlight = mapReadwiseHighlightToItem(
      { id: 9001, text: "a highlight that happens to share the book's numeric id" },
      { syncedAt: NOW },
    );
    if (book === null || highlight === null) throw new Error("expected mapping to succeed");
    expect(book.externalId).not.toBe(highlight.externalId);
    expect(itemPrimaryKey(book.service, book.externalId)).toBe("readwise:book/9001");
    expect(itemPrimaryKey(highlight.service, highlight.externalId)).toBe("readwise:9001");
  });

  test("metadata.book_id is the NUMBER, so it joins a highlight's metadata.book_id", () => {
    const book = mapReadwiseBookToItem(makeBook({ id: 9001 }), { syncedAt: NOW });
    const highlight = mapReadwiseHighlightToItem(
      { id: 7, text: "quoted text", book_id: 9001 },
      { syncedAt: NOW },
    );
    if (book === null || highlight === null) throw new Error("expected mapping to succeed");
    expect(meta(book)["book_id"]).toBe(9001);
    expect(meta(book)["book_id"]).toBe(meta(highlight)["book_id"]);
  });

  test("title is the trimmed book title", () => {
    const row = mapReadwiseBookToItem(makeBook({ title: "  Release It!  " }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Release It!");
  });

  test("title falls back to the author, then to `Book <id>`", () => {
    const noTitle = makeBook();
    delete noTitle["title"];
    const onAuthor = mapReadwiseBookToItem(noTitle, { syncedAt: NOW });
    if (onAuthor === null) throw new Error("expected mapping to succeed");
    expect(onAuthor.title).toBe("Michael T. Nygard");

    const blank = mapReadwiseBookToItem(makeBook({ title: "   ", author: "" }), { syncedAt: NOW });
    if (blank === null) throw new Error("expected mapping to succeed");
    expect(blank.title).toBe("Book 9001");
  });

  test("bodyPreview is the document note when present", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("The stability-patterns chapters are the ones worth re-reading");
  });

  test("bodyPreview falls back to the author, then the category, then the title", () => {
    const noNote = makeBook();
    delete noNote["document_note"];
    const onAuthor = mapReadwiseBookToItem(noNote, { syncedAt: NOW });
    if (onAuthor === null) throw new Error("expected mapping to succeed");
    expect(onAuthor.bodyPreview).toBe("Michael T. Nygard");

    const noAuthor = makeBook({ document_note: "", author: "" });
    const onCategory = mapReadwiseBookToItem(noAuthor, { syncedAt: NOW });
    if (onCategory === null) throw new Error("expected mapping to succeed");
    expect(onCategory.bodyPreview).toBe("books");

    const bare = makeBook({ document_note: "", author: "", category: "" });
    const onTitle = mapReadwiseBookToItem(bare, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe("Release It! Design and Deploy Production-Ready Software");
  });

  test("ISO-8601 timestamps → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["last_highlight_at"]).toBe(LAST_HIGHLIGHT_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    expect(meta(row)["updated_at"]).toBe(Date.parse(UPDATED_ISO));
  });

  test("modifiedAt prefers updated, then last_highlight_at, then syncedAt", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdated = makeBook();
    delete noUpdated["updated"];
    const onLastHighlight = mapReadwiseBookToItem(noUpdated, { syncedAt: NOW });
    if (onLastHighlight === null) throw new Error("expected mapping to succeed");
    expect(onLastHighlight.modifiedAt).toBe(LAST_HIGHLIGHT_MS);

    const noTimes = makeBook();
    delete noTimes["updated"];
    delete noTimes["last_highlight_at"];
    const fallback = mapReadwiseBookToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["last_highlight_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("canonicalUrl/url is the source url when present", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://example.com/article");
    expect(row.url).toBe("https://example.com/article");
    expect(meta(row)["canonical_url"]).toBe("https://example.com/article");
    expect(meta(row)["source_url"]).toBe("https://example.com/article");
  });

  test("canonicalUrl/url falls back to the Readwise highlights_url (Kindle books)", () => {
    const kindle = mapReadwiseBookToItem(makeBook({ source_url: null }), { syncedAt: NOW });
    if (kindle === null) throw new Error("expected mapping to succeed");
    expect(kindle.canonicalUrl).toBe("https://readwise.io/bookreview/9001");
    expect(kindle.url).toBe("https://readwise.io/bookreview/9001");
    expect(meta(kindle)["source_url"]).toBeNull();
    expect(meta(kindle)["highlights_url"]).toBe("https://readwise.io/bookreview/9001");
  });

  test("canonicalUrl/url is null when both urls are missing/empty", () => {
    const bare = makeBook({ source_url: "", highlights_url: "" });
    const row = mapReadwiseBookToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();

    const missing = makeBook();
    delete missing["source_url"];
    delete missing["highlights_url"];
    const noUrls = mapReadwiseBookToItem(missing, { syncedAt: NOW });
    if (noUrls === null) throw new Error("expected mapping to succeed");
    expect(noUrls.canonicalUrl).toBeNull();
  });

  test("tags are reduced to the name array", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["reliability", "retries"]);
  });

  test("full metadata flows through", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["title"]).toBe("Release It! Design and Deploy Production-Ready Software");
    expect(m["author"]).toBe("Michael T. Nygard");
    expect(m["category"]).toBe("books");
    expect(m["source"]).toBe("kindle");
    expect(m["num_highlights"]).toBe(42);
    expect(m["asin"]).toBe("B00A32NXZO");
    expect(m["document_note"]).toBe(
      "The stability-patterns chapters are the ones worth re-reading",
    );
    expect(m["highlights_url"]).toBe("https://readwise.io/bookreview/9001");
  });

  test("cover_image_url and the resurface-scheduler fields are NOT stored in metadata", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["cover_image_url"]).toBeUndefined();
    expect(meta(row)["resurface_weighting"]).toBeUndefined();
    expect(meta(row)["source_syncs_all_books_together"]).toBeUndefined();
  });

  test("missing fields are null-passthrough in metadata", () => {
    const sparse = makeBook();
    delete sparse["author"];
    delete sparse["category"];
    delete sparse["source"];
    delete sparse["num_highlights"];
    delete sparse["asin"];
    delete sparse["document_note"];
    delete sparse["tags"];
    const row = mapReadwiseBookToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["author"]).toBeNull();
    expect(m["category"]).toBeNull();
    expect(m["source"]).toBeNull();
    expect(m["num_highlights"]).toBeNull();
    expect(m["asin"]).toBeNull();
    expect(m["document_note"]).toBeNull();
    expect(m["tags"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapReadwiseBookToItem(makeBook(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});
