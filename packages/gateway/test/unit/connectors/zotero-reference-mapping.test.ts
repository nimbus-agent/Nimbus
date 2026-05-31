import { describe, expect, test } from "bun:test";

import {
  creatorNames,
  mapZoteroReferenceToItem,
  tagNames,
} from "../../../src/connectors/zotero-reference-mapping.ts";

const MODIFIED_ISO = "2024-03-02T08:00:00Z";
const MODIFIED_MS = Date.parse(MODIFIED_ISO);
const ADDED_ISO = "2024-03-01T12:00:00Z";
const ADDED_MS = Date.parse(ADDED_ISO);

function makeItem(dataOver: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) {
  return {
    key: "ABCD1234",
    version: 100,
    library: { type: "user", id: 12345 },
    data: {
      key: "ABCD1234",
      itemType: "journalArticle",
      title: "Exponential backoff with jitter avoids thundering-herd retries",
      abstractNote: "A study of full-jitter retry strategies for distributed queues.",
      DOI: "10.1145/1234567.8901234",
      publicationTitle: "Journal of Reliability Engineering",
      url: "https://example.com/article",
      date: "2024",
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "author", firstName: "Grace", lastName: "Hopper" },
      ],
      tags: [{ tag: "reliability" }, { tag: "retries" }],
      collections: ["COLL01", "COLL02"],
      dateModified: MODIFIED_ISO,
      dateAdded: ADDED_ISO,
      ...dataOver,
    },
    ...rootOver,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapZoteroReferenceToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapZoteroReferenceToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapZoteroReferenceToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapZoteroReferenceToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when key is missing/empty", () => {
    const noKey = makeItem();
    delete (noKey as Record<string, unknown>)["key"];
    expect(mapZoteroReferenceToItem(noKey, { syncedAt: NOW })).toBeNull();
    expect(mapZoteroReferenceToItem(makeItem({}, { key: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("returns null when data is missing/not an object", () => {
    const noData = makeItem();
    delete (noData as Record<string, unknown>)["data"];
    expect(mapZoteroReferenceToItem(noData, { syncedAt: NOW })).toBeNull();
    expect(mapZoteroReferenceToItem(makeItem({}, { data: "x" }), { syncedAt: NOW })).toBeNull();
  });

  test("skips attachment and note item types", () => {
    expect(
      mapZoteroReferenceToItem(makeItem({ itemType: "attachment" }), { syncedAt: NOW }),
    ).toBeNull();
    expect(mapZoteroReferenceToItem(makeItem({ itemType: "note" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the item key", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("zotero");
    expect(row.type).toBe("reference");
    expect(row.externalId).toBe("ABCD1234");
  });

  test("title is the data.title (no truncation when short)", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Exponential backoff with jitter avoids thundering-herd retries");
  });

  test("title is truncated to 120 chars + ellipsis when long", () => {
    const long = "x".repeat(300);
    const row = mapZoteroReferenceToItem(makeItem({ title: long }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe(`${"x".repeat(120)}…`);
    expect(row.title.length).toBe(121);
  });

  test("title falls back to `<itemType> <key>` when title missing/empty", () => {
    const noTitle = makeItem();
    delete ((noTitle as Record<string, unknown>)["data"] as Record<string, unknown>)["title"];
    const row = mapZoteroReferenceToItem(noTitle, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("journalArticle ABCD1234");

    const emptyTitle = mapZoteroReferenceToItem(makeItem({ title: "   " }), { syncedAt: NOW });
    if (emptyTitle === null) throw new Error("expected mapping to succeed");
    expect(emptyTitle.title).toBe("journalArticle ABCD1234");
  });

  test("title falls back to `Reference <key>` when both title and itemType missing", () => {
    const bare = makeItem();
    const d = (bare as Record<string, unknown>)["data"] as Record<string, unknown>;
    delete d["title"];
    delete d["itemType"];
    const row = mapZoteroReferenceToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Reference ABCD1234");
  });

  test("bodyPreview is the (truncated) abstract when present", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("A study of full-jitter retry strategies for distributed queues.");
  });

  test("abstract is truncated to 500 chars + ellipsis in metadata + bodyPreview", () => {
    const long = "a".repeat(800);
    const row = mapZoteroReferenceToItem(makeItem({ abstractNote: long }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["abstract"]).toBe(`${"a".repeat(500)}…`);
    expect(row.bodyPreview).toBe(`${"a".repeat(500)}…`);
  });

  test("bodyPreview falls back to creators then title when abstract missing", () => {
    const noAbstract = makeItem();
    delete ((noAbstract as Record<string, unknown>)["data"] as Record<string, unknown>)[
      "abstractNote"
    ];
    const row = mapZoteroReferenceToItem(noAbstract, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Ada Lovelace, Grace Hopper");

    const noAbstractNoCreators = makeItem();
    const d = (noAbstractNoCreators as Record<string, unknown>)["data"] as Record<string, unknown>;
    delete d["abstractNote"];
    delete d["creators"];
    const row2 = mapZoteroReferenceToItem(noAbstractNoCreators, { syncedAt: NOW });
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.bodyPreview).toBe(row2.title);
  });

  test("ISO-8601 timestamps → epoch ms in metadata", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["date_modified"]).toBe(MODIFIED_MS);
    expect(meta(row)["date_added"]).toBe(ADDED_MS);
  });

  test("modifiedAt prefers dateModified, then dateAdded, then syncedAt", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(MODIFIED_MS);

    const noMod = makeItem();
    delete ((noMod as Record<string, unknown>)["data"] as Record<string, unknown>)["dateModified"];
    const onlyAdded = mapZoteroReferenceToItem(noMod, { syncedAt: NOW });
    if (onlyAdded === null) throw new Error("expected mapping to succeed");
    expect(onlyAdded.modifiedAt).toBe(ADDED_MS);

    const noTimes = makeItem();
    const d = (noTimes as Record<string, unknown>)["data"] as Record<string, unknown>;
    delete d["dateModified"];
    delete d["dateAdded"];
    const fallback = mapZoteroReferenceToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["date_modified"]).toBeNull();
    expect(meta(fallback)["date_added"]).toBeNull();
  });

  test("canonicalUrl/url is the source url; null/missing/empty → null", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBe("https://example.com/article");
    expect(row.canonicalUrl).toBe("https://example.com/article");
    expect(meta(row)["url"]).toBe("https://example.com/article");

    const empty = mapZoteroReferenceToItem(makeItem({ url: "" }), { syncedAt: NOW });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.url).toBeNull();
    expect(empty.canonicalUrl).toBeNull();
  });

  test("creators are reduced to a formatted name array", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["creators"]).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  test("tags + collections flow through as string arrays", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["reliability", "retries"]);
    expect(meta(row)["collections"]).toEqual(["COLL01", "COLL02"]);
  });

  test("full metadata flows through", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["key"]).toBe("ABCD1234");
    expect(m["version"]).toBe(100);
    expect(m["item_type"]).toBe("journalArticle");
    expect(m["title"]).toBe("Exponential backoff with jitter avoids thundering-herd retries");
    expect(m["doi"]).toBe("10.1145/1234567.8901234");
    expect(m["publication_title"]).toBe("Journal of Reliability Engineering");
    expect(m["date"]).toBe("2024");
  });

  test("missing optional fields are null-passthrough in metadata", () => {
    const sparse = makeItem();
    const d = (sparse as Record<string, unknown>)["data"] as Record<string, unknown>;
    delete d["DOI"];
    delete d["abstractNote"];
    delete d["publicationTitle"];
    delete d["date"];
    delete d["tags"];
    delete d["collections"];
    delete d["creators"];
    const row = mapZoteroReferenceToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["doi"]).toBeNull();
    expect(m["abstract"]).toBeNull();
    expect(m["publication_title"]).toBeNull();
    expect(m["date"]).toBeNull();
    expect(m["tags"]).toEqual([]);
    expect(m["collections"]).toEqual([]);
    expect(m["creators"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapZoteroReferenceToItem(makeItem(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("creatorNames", () => {
  test("supports the lastName/firstName shape", () => {
    expect(
      creatorNames([{ firstName: "Ada", lastName: "Lovelace" }, { lastName: "Knuth" }]),
    ).toEqual(["Ada Lovelace", "Knuth"]);
  });

  test("supports the single-field `name` shape (institutions)", () => {
    expect(creatorNames([{ name: "ACME Corp" }])).toEqual(["ACME Corp"]);
  });

  test("tolerates non-array, non-object, and empty entries", () => {
    expect(creatorNames(undefined)).toEqual([]);
    expect(creatorNames("nope")).toEqual([]);
    expect(creatorNames([null, 7, "x", {}, { firstName: "", lastName: "" }])).toEqual([]);
  });
});

describe("tagNames", () => {
  test("extracts the tag strings", () => {
    expect(tagNames([{ tag: "a" }, { tag: "b" }])).toEqual(["a", "b"]);
  });

  test("tolerates non-array, non-object, and tagless entries", () => {
    expect(tagNames(undefined)).toEqual([]);
    expect(tagNames("nope")).toEqual([]);
    expect(tagNames([null, 7, "x", { tag: "" }, { tag: "ok" }])).toEqual(["ok"]);
  });
});
