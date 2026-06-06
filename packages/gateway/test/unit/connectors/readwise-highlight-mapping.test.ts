import { describe, expect, test } from "bun:test";

import {
  mapReadwiseHighlightToItem,
  tagNames,
} from "../../../src/connectors/readwise-highlight-mapping.ts";

const HIGHLIGHTED_ISO = "2024-03-01T12:00:00.000Z";
const HIGHLIGHTED_MS = Date.parse(HIGHLIGHTED_ISO);
const UPDATED_ISO = "2024-03-02T08:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED_ISO);

function makeHighlight(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    highlighted_at: HIGHLIGHTED_ISO,
    updated: UPDATED_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapReadwiseHighlightToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapReadwiseHighlightToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseHighlightToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseHighlightToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or not a number", () => {
    const noId = makeHighlight();
    delete noId["id"];
    expect(mapReadwiseHighlightToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapReadwiseHighlightToItem(makeHighlight({ id: "123" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the stringified numeric id", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("readwise");
    expect(row.type).toBe("highlight");
    expect(row.externalId).toBe("123456");
  });

  test("title is the first 80 chars of text (no truncation when short)", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Exponential backoff with jitter avoids thundering-herd retries");
  });

  test("title is truncated to 80 chars + ellipsis when text is long", () => {
    const long = "x".repeat(200);
    const row = mapReadwiseHighlightToItem(makeHighlight({ text: long }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe(`${"x".repeat(80)}…`);
    expect(row.title.length).toBe(81);
  });

  test("title trims whitespace before measuring", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight({ text: "   hi there   " }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("hi there");
  });

  test("title falls back to `Highlight <id>` when text missing/empty", () => {
    const noText = makeHighlight();
    delete noText["text"];
    const row = mapReadwiseHighlightToItem(noText, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Highlight 123456");

    const emptyText = mapReadwiseHighlightToItem(makeHighlight({ text: "   " }), { syncedAt: NOW });
    if (emptyText === null) throw new Error("expected mapping to succeed");
    expect(emptyText.title).toBe("Highlight 123456");
  });

  test("bodyPreview is the note when present", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Use full jitter for queue workers");
  });

  test("bodyPreview falls back to the highlight text when note missing/empty", () => {
    const noNote = makeHighlight();
    delete noNote["note"];
    const row = mapReadwiseHighlightToItem(noNote, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Exponential backoff with jitter avoids thundering-herd retries");

    const emptyNote = mapReadwiseHighlightToItem(makeHighlight({ note: "" }), { syncedAt: NOW });
    if (emptyNote === null) throw new Error("expected mapping to succeed");
    expect(emptyNote.bodyPreview).toBe(
      "Exponential backoff with jitter avoids thundering-herd retries",
    );
  });

  test("ISO-8601 timestamps → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["highlighted_at"]).toBe(HIGHLIGHTED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    expect(meta(row)["updated_at"]).toBe(Date.parse(UPDATED_ISO));
  });

  test("modifiedAt prefers updated, then highlighted_at, then syncedAt", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdated = makeHighlight();
    delete noUpdated["updated"];
    const onlyHighlighted = mapReadwiseHighlightToItem(noUpdated, { syncedAt: NOW });
    if (onlyHighlighted === null) throw new Error("expected mapping to succeed");
    expect(onlyHighlighted.modifiedAt).toBe(HIGHLIGHTED_MS);

    const noTimes = makeHighlight();
    delete noTimes["updated"];
    delete noTimes["highlighted_at"];
    const fallback = mapReadwiseHighlightToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["highlighted_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("canonicalUrl/url is the source article url for web highlights", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://example.com/article");
    expect(row.url).toBe("https://example.com/article");
    expect(meta(row)["canonical_url"]).toBe("https://example.com/article");
    expect(meta(row)["source_url"]).toBe("https://example.com/article");
  });

  test("canonicalUrl/url is null for book highlights (null/missing/empty source url)", () => {
    const nullUrl = mapReadwiseHighlightToItem(makeHighlight({ url: null }), { syncedAt: NOW });
    if (nullUrl === null) throw new Error("expected mapping to succeed");
    expect(nullUrl.canonicalUrl).toBeNull();
    expect(nullUrl.url).toBeNull();

    const noUrl = makeHighlight();
    delete noUrl["url"];
    const missing = mapReadwiseHighlightToItem(noUrl, { syncedAt: NOW });
    if (missing === null) throw new Error("expected mapping to succeed");
    expect(missing.canonicalUrl).toBeNull();

    const empty = mapReadwiseHighlightToItem(makeHighlight({ url: "" }), { syncedAt: NOW });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.canonicalUrl).toBeNull();
  });

  test("tags are reduced to the name array", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["reliability", "retries"]);
  });

  test("text is stored in full in metadata", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["text"]).toBe(
      "Exponential backoff with jitter avoids thundering-herd retries",
    );
  });

  test("full metadata flows through", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["highlight_id"]).toBe("123456");
    expect(m["note"]).toBe("Use full jitter for queue workers");
    expect(m["book_id"]).toBe(9001);
    expect(m["location"]).toBe(42);
    expect(m["location_type"]).toBe("location");
    expect(m["color"]).toBe("yellow");
  });

  test("missing fields are null-passthrough in metadata", () => {
    const sparse = makeHighlight();
    delete sparse["note"];
    delete sparse["location"];
    delete sparse["location_type"];
    delete sparse["color"];
    delete sparse["book_id"];
    delete sparse["tags"];
    const row = mapReadwiseHighlightToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["note"]).toBeNull();
    expect(m["location"]).toBeNull();
    expect(m["location_type"]).toBeNull();
    expect(m["color"]).toBeNull();
    expect(m["book_id"]).toBeNull();
    expect(m["tags"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapReadwiseHighlightToItem(makeHighlight(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("tagNames", () => {
  test("extracts the name strings", () => {
    expect(
      tagNames([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ]),
    ).toEqual(["a", "b"]);
  });

  test("tolerates non-array, non-object, and nameless entries", () => {
    expect(tagNames(undefined)).toEqual([]);
    expect(tagNames("nope")).toEqual([]);
    expect(tagNames([null, 7, "x", { id: 1 }, { id: 2, name: "" }, { id: 3, name: "ok" }])).toEqual(
      ["ok"],
    );
  });
});
