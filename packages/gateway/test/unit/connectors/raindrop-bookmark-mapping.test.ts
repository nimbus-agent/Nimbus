import { describe, expect, test } from "bun:test";

import {
  mapRaindropBookmarkToItem,
  tagStrings,
} from "../../../src/connectors/raindrop-bookmark-mapping.ts";

// 2024-03-01T12:00:00.000Z → Date.parse → epoch ms.
const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const UPDATED_ISO = "2024-03-02T08:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED_ISO);

function makeBookmark(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    created: CREATED_ISO,
    lastUpdate: UPDATED_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapRaindropBookmarkToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapRaindropBookmarkToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapRaindropBookmarkToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapRaindropBookmarkToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when _id is missing or not a number", () => {
    const noId = makeBookmark();
    delete (noId as Record<string, unknown>)["_id"];
    expect(mapRaindropBookmarkToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapRaindropBookmarkToItem(makeBookmark({ _id: "123" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the stringified numeric _id", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("raindrop");
    expect(row.type).toBe("bookmark");
    expect(row.externalId).toBe("123456");
  });

  test("title is the bookmark title when present", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Exponential backoff with jitter avoids thundering-herd retries");
  });

  test("title falls back to the link when title missing/empty", () => {
    const noTitle = makeBookmark();
    delete (noTitle as Record<string, unknown>)["title"];
    const row = mapRaindropBookmarkToItem(noTitle, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("https://example.com/article");

    const emptyTitle = mapRaindropBookmarkToItem(makeBookmark({ title: "" }), { syncedAt: NOW });
    if (emptyTitle === null) throw new Error("expected mapping to succeed");
    expect(emptyTitle.title).toBe("https://example.com/article");
  });

  test("title falls back to `Bookmark <id>` when title and link missing/empty", () => {
    const bare = makeBookmark();
    delete (bare as Record<string, unknown>)["title"];
    delete (bare as Record<string, unknown>)["link"];
    const row = mapRaindropBookmarkToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Bookmark 123456");
  });

  test("bodyPreview is the excerpt when present", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("A clear explanation of full jitter for queue workers");
  });

  test("bodyPreview falls back to note, then domain, then title", () => {
    const noExcerpt = makeBookmark();
    delete (noExcerpt as Record<string, unknown>)["excerpt"];
    const onNote = mapRaindropBookmarkToItem(noExcerpt, { syncedAt: NOW });
    if (onNote === null) throw new Error("expected mapping to succeed");
    expect(onNote.bodyPreview).toBe("Use full jitter for queue workers");

    const noNote = makeBookmark();
    delete (noNote as Record<string, unknown>)["excerpt"];
    delete (noNote as Record<string, unknown>)["note"];
    const onDomain = mapRaindropBookmarkToItem(noNote, { syncedAt: NOW });
    if (onDomain === null) throw new Error("expected mapping to succeed");
    expect(onDomain.bodyPreview).toBe("example.com");

    const noDomain = makeBookmark();
    delete (noDomain as Record<string, unknown>)["excerpt"];
    delete (noDomain as Record<string, unknown>)["note"];
    delete (noDomain as Record<string, unknown>)["domain"];
    const onTitle = mapRaindropBookmarkToItem(noDomain, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe(
      "Exponential backoff with jitter avoids thundering-herd retries",
    );
  });

  test("ISO-8601 timestamps → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    expect(meta(row)["updated_at"]).toBe(Date.parse(UPDATED_ISO));
  });

  test("modifiedAt prefers lastUpdate, then created, then syncedAt", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdate = makeBookmark();
    delete (noUpdate as Record<string, unknown>)["lastUpdate"];
    const onlyCreated = mapRaindropBookmarkToItem(noUpdate, { syncedAt: NOW });
    if (onlyCreated === null) throw new Error("expected mapping to succeed");
    expect(onlyCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makeBookmark();
    delete (noTimes as Record<string, unknown>)["lastUpdate"];
    delete (noTimes as Record<string, unknown>)["created"];
    const fallback = mapRaindropBookmarkToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("canonicalUrl/url is the bookmarked link", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://example.com/article");
    expect(row.url).toBe("https://example.com/article");
    expect(meta(row)["canonical_url"]).toBe("https://example.com/article");
    expect(meta(row)["link"]).toBe("https://example.com/article");
  });

  test("canonicalUrl/url is null when the link is null/missing/empty", () => {
    const nullLink = mapRaindropBookmarkToItem(makeBookmark({ link: null }), { syncedAt: NOW });
    if (nullLink === null) throw new Error("expected mapping to succeed");
    expect(nullLink.canonicalUrl).toBeNull();
    expect(nullLink.url).toBeNull();

    const noLink = makeBookmark();
    delete (noLink as Record<string, unknown>)["link"];
    const missing = mapRaindropBookmarkToItem(noLink, { syncedAt: NOW });
    if (missing === null) throw new Error("expected mapping to succeed");
    expect(missing.canonicalUrl).toBeNull();

    const empty = mapRaindropBookmarkToItem(makeBookmark({ link: "" }), { syncedAt: NOW });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.canonicalUrl).toBeNull();
  });

  test("tags are stored as the string array verbatim", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["reliability", "retries"]);
  });

  test("full metadata flows through", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["bookmark_id"]).toBe("123456");
    expect(m["title"]).toBe("Exponential backoff with jitter avoids thundering-herd retries");
    expect(m["excerpt"]).toBe("A clear explanation of full jitter for queue workers");
    expect(m["note"]).toBe("Use full jitter for queue workers");
    expect(m["domain"]).toBe("example.com");
    expect(m["type"]).toBe("article");
    expect(m["collection_id"]).toBe(9001);
  });

  test("cover is NOT stored in metadata", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["cover"]).toBeUndefined();
  });

  test("missing fields are null-passthrough in metadata", () => {
    const sparse = makeBookmark();
    delete (sparse as Record<string, unknown>)["excerpt"];
    delete (sparse as Record<string, unknown>)["note"];
    delete (sparse as Record<string, unknown>)["domain"];
    delete (sparse as Record<string, unknown>)["type"];
    delete (sparse as Record<string, unknown>)["collectionId"];
    delete (sparse as Record<string, unknown>)["tags"];
    const row = mapRaindropBookmarkToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["excerpt"]).toBeNull();
    expect(m["note"]).toBeNull();
    expect(m["domain"]).toBeNull();
    expect(m["type"]).toBeNull();
    expect(m["collection_id"]).toBeNull();
    expect(m["tags"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapRaindropBookmarkToItem(makeBookmark(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("tagStrings", () => {
  test("extracts the string entries verbatim", () => {
    expect(tagStrings(["a", "b"])).toEqual(["a", "b"]);
  });

  test("tolerates non-array and non-string entries", () => {
    expect(tagStrings(undefined)).toEqual([]);
    expect(tagStrings("nope")).toEqual([]);
    expect(tagStrings([null, 7, "x", { name: "obj" }, "ok"])).toEqual(["x", "ok"]);
  });
});
