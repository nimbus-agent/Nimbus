import { describe, expect, test } from "bun:test";

import { mapRaindropBookmarkToItem } from "../../../src/connectors/raindrop-bookmark-mapping.ts";
import { mapRaindropCollectionToItem } from "../../../src/connectors/raindrop-collection-mapping.ts";
import { itemPrimaryKey } from "../../../src/index/item-key.ts";

const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const UPDATED_ISO = "2024-03-02T08:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED_ISO);

function makeCollection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 9001,
    title: "Distributed systems reading",
    count: 137,
    public: false,
    view: "list",
    color: "#0N0N0N",
    sort: -1,
    expanded: true,
    cover: ["https://example.com/cover.png"],
    access: { level: 4, draggable: true },
    collaborators: { $id: "abc" },
    user: { $id: 42 },
    parent: { $id: 7 },
    created: CREATED_ISO,
    lastUpdate: UPDATED_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapRaindropCollectionToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapRaindropCollectionToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapRaindropCollectionToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapRaindropCollectionToItem(42, { syncedAt: NOW })).toBeNull();
    expect(mapRaindropCollectionToItem([makeCollection()], { syncedAt: NOW })).toBeNull();
  });

  test("returns null when _id is missing or not a number", () => {
    const noId = makeCollection();
    delete noId["_id"];
    expect(mapRaindropCollectionToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(
      mapRaindropCollectionToItem(makeCollection({ _id: "9001" }), { syncedAt: NOW }),
    ).toBeNull();
    expect(
      mapRaindropCollectionToItem(makeCollection({ _id: Number.NaN }), { syncedAt: NOW }),
    ).toBeNull();
  });

  test("service/type fixed; externalId is `collection/<numeric _id>`", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("raindrop");
    expect(row.type).toBe("collection");
    expect(row.externalId).toBe("collection/9001");
  });

  test("the `collection/` prefix keeps a collection distinct from a bookmark sharing the id", () => {
    // Raindrop numbers collections and raindrops (bookmarks) in SEPARATE id
    // spaces, so collection 9001 and bookmark 9001 both exist. `itemPrimaryKey`
    // is `<service>:<externalId>` and the item table upserts ON CONFLICT(id) —
    // an unprefixed collection externalId would silently overwrite the bookmark
    // row (and vice versa) on every sync.
    const collection = mapRaindropCollectionToItem(makeCollection({ _id: 9001 }), {
      syncedAt: NOW,
    });
    const bookmark = mapRaindropBookmarkToItem(
      { _id: 9001, title: "a bookmark that happens to share the collection's id" },
      { syncedAt: NOW },
    );
    if (collection === null || bookmark === null) throw new Error("expected mapping to succeed");
    expect(collection.externalId).not.toBe(bookmark.externalId);
    expect(itemPrimaryKey(collection.service, collection.externalId)).toBe(
      "raindrop:collection/9001",
    );
    expect(itemPrimaryKey(bookmark.service, bookmark.externalId)).toBe("raindrop:9001");
  });

  test("metadata.collection_id is the NUMBER, so it joins a bookmark's metadata.collection_id", () => {
    const collection = mapRaindropCollectionToItem(makeCollection({ _id: 9001 }), {
      syncedAt: NOW,
    });
    const bookmark = mapRaindropBookmarkToItem(
      { _id: 5, title: "an article", collectionId: 9001 },
      { syncedAt: NOW },
    );
    if (collection === null || bookmark === null) throw new Error("expected mapping to succeed");
    expect(meta(collection)["collection_id"]).toBe(9001);
    expect(meta(collection)["collection_id"]).toBe(meta(bookmark)["collection_id"]);
  });

  test("title is the trimmed collection title", () => {
    const row = mapRaindropCollectionToItem(makeCollection({ title: "  Reading  " }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Reading");
  });

  test("title falls back to `Collection <id>` when the title is missing/blank", () => {
    const noTitle = makeCollection();
    delete noTitle["title"];
    const missing = mapRaindropCollectionToItem(noTitle, { syncedAt: NOW });
    if (missing === null) throw new Error("expected mapping to succeed");
    expect(missing.title).toBe("Collection 9001");

    const blank = mapRaindropCollectionToItem(makeCollection({ title: "   " }), { syncedAt: NOW });
    if (blank === null) throw new Error("expected mapping to succeed");
    expect(blank.title).toBe("Collection 9001");
  });

  test("bodyPreview is the title — the Collection object carries no description field", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Distributed systems reading");
  });

  test("ISO-8601 timestamps → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    expect(meta(row)["updated_at"]).toBe(Date.parse(UPDATED_ISO));
  });

  test("modifiedAt prefers lastUpdate, then created, then syncedAt", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdate = makeCollection();
    delete noUpdate["lastUpdate"];
    const onlyCreated = mapRaindropCollectionToItem(noUpdate, { syncedAt: NOW });
    if (onlyCreated === null) throw new Error("expected mapping to succeed");
    expect(onlyCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makeCollection();
    delete noTimes["lastUpdate"];
    delete noTimes["created"];
    const fallback = mapRaindropCollectionToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("url/canonicalUrl are null — the API returns no URL for a collection", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("parent.$id becomes parent_id; a root collection has parent_id null", () => {
    const child = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (child === null) throw new Error("expected mapping to succeed");
    expect(meta(child)["parent_id"]).toBe(7);

    const noParent = makeCollection();
    delete noParent["parent"];
    const root = mapRaindropCollectionToItem(noParent, { syncedAt: NOW });
    if (root === null) throw new Error("expected mapping to succeed");
    expect(meta(root)["parent_id"]).toBeNull();

    const malformed = mapRaindropCollectionToItem(makeCollection({ parent: { $id: "7" } }), {
      syncedAt: NOW,
    });
    if (malformed === null) throw new Error("expected mapping to succeed");
    expect(meta(malformed)["parent_id"]).toBeNull();

    const notAnObject = mapRaindropCollectionToItem(makeCollection({ parent: 7 }), {
      syncedAt: NOW,
    });
    if (notAnObject === null) throw new Error("expected mapping to succeed");
    expect(meta(notAnObject)["parent_id"]).toBeNull();
  });

  test("full metadata flows through", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["title"]).toBe("Distributed systems reading");
    expect(m["count"]).toBe(137);
    expect(m["public"]).toBe(false);
    expect(m["view"]).toBe("list");
    expect(m["color"]).toBe("#0N0N0N");
    expect(m["sort"]).toBe(-1);
  });

  test("`public: true` flows through as a boolean, not a truthiness coercion", () => {
    const row = mapRaindropCollectionToItem(makeCollection({ public: true }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["public"]).toBe(true);

    const nonBool = mapRaindropCollectionToItem(makeCollection({ public: "yes" }), {
      syncedAt: NOW,
    });
    if (nonBool === null) throw new Error("expected mapping to succeed");
    expect(meta(nonBool)["public"]).toBeNull();
  });

  test("cover, access, collaborators, user and expanded are NOT stored in metadata", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["cover"]).toBeUndefined();
    expect(m["access"]).toBeUndefined();
    expect(m["collaborators"]).toBeUndefined();
    expect(m["user"]).toBeUndefined();
    expect(m["expanded"]).toBeUndefined();
  });

  test("missing fields are null-passthrough in metadata", () => {
    const sparse = makeCollection();
    delete sparse["count"];
    delete sparse["public"];
    delete sparse["view"];
    delete sparse["color"];
    delete sparse["sort"];
    const row = mapRaindropCollectionToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["count"]).toBeNull();
    expect(m["public"]).toBeNull();
    expect(m["view"]).toBeNull();
    expect(m["color"]).toBeNull();
    expect(m["sort"]).toBeNull();
    expect(m["title"]).toBe("Distributed systems reading");
  });

  test("syncedAt propagates", () => {
    const row = mapRaindropCollectionToItem(makeCollection(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});
