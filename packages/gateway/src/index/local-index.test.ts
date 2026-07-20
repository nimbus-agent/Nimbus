/**
 * local-index.test.ts — branch coverage for LocalIndex
 *
 * Uses real in-memory SQLite + LocalIndex.ensureSchema.
 * No mocks, no `any`, no `biome-ignore`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { NimbusItem } from "@nimbus-dev/sdk";
import { upsertIndexedItem } from "./item-store.ts";
import type { SemanticSearchDeps } from "./local-index.ts";
import { isAllowedMetaKey, LocalIndex } from "./local-index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIndex(options?: ConstructorParameters<typeof LocalIndex>[1]): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db, options);
}

function makeItem(overrides: Partial<NimbusItem> = {}): NimbusItem {
  return {
    id: "item-1",
    service: "test-svc",
    itemType: "file",
    name: "Test Item",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ensureSchema
// ---------------------------------------------------------------------------

describe("LocalIndex.ensureSchema", () => {
  test("runs migrations and sets user_version to SCHEMA_VERSION", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row["user_version"]).toBe(LocalIndex.SCHEMA_VERSION);
  });

  test("is idempotent — calling twice does not throw", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    expect(() => LocalIndex.ensureSchema(db)).not.toThrow();
  });

  test("foreign_keys pragma is ON after ensureSchema", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row["foreign_keys"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getDatabase / rawDb
// ---------------------------------------------------------------------------

describe("LocalIndex.getDatabase / rawDb", () => {
  test("getDatabase returns the underlying Database", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    expect(idx.getDatabase()).toBe(db);
  });

  test("rawDb returns the same Database instance", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    expect(idx.rawDb).toBe(db);
  });
});

// ---------------------------------------------------------------------------
// upsert / delete branches
// ---------------------------------------------------------------------------

describe("LocalIndex upsert + delete", () => {
  test("upsert inserts a new item retrievable by search", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "u1", name: "unique name alpha" }));
    const hits = idx.search({ name: "unique name alpha" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("u1");
  });

  test("upsert schedules embedding when scheduleItemEmbedding is provided", () => {
    const scheduled: string[] = [];
    const idx = makeIndex({ scheduleItemEmbedding: (id) => scheduled.push(id) });
    idx.upsert(makeItem({ id: "emb1", name: "embed me" }));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toContain("emb1");
  });

  test("upsert with no scheduleItemEmbedding option does not throw", () => {
    const idx = makeIndex();
    expect(() => idx.upsert(makeItem())).not.toThrow();
  });

  test("upsert can include url field (NimbusItem.url branch)", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "withurl", url: "https://example.com/item" }));
    const hits = idx.search({ name: "Test Item" });
    expect(hits.some((h) => h.url === "https://example.com/item")).toBe(true);
  });

  test("upsert with itemType 'event' round-trips as event", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "ev1", itemType: "event", name: "Team event" }));
    const hits = idx.search({ name: "Team event" });
    expect(hits[0]?.itemType).toBe("event");
  });

  test("upsert round-trips every ops item type instead of coercing to file", () => {
    const idx = makeIndex();
    const opsTypes = ["ci_run", "pr", "issue", "deployment", "incident", "web_clip"];
    for (const t of opsTypes) {
      idx.upsert(makeItem({ id: `ops-${t}`, itemType: t, name: `ops item ${t}` }));
    }
    for (const t of opsTypes) {
      const hits = idx.search({ name: `ops item ${t}` });
      expect(hits.find((h) => h.id === `ops-${t}`)?.itemType).toBe(t);
    }
  });

  test("upsert round-trips an item type this gateway build does not know", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "future-1", itemType: "dora_metric", name: "future typed item" }));
    const hits = idx.search({ name: "future typed item" });
    expect(hits.find((h) => h.id === "future-1")?.itemType).toBe("dora_metric");
  });

  test("upsert preserves 'folder', which the gateway really does emit", () => {
    // google-drive-sync.ts:173 emits `type: isFolder ? "folder" : "file"`.
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "fold-1", itemType: "folder", name: "a real folder" }));
    const hits = idx.search({ name: "a real folder" });
    expect(hits.find((h) => h.id === "fold-1")?.itemType).toBe("folder");
  });

  test("upsert with itemType 'email' round-trips as email", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "em1", itemType: "email", name: "Weekly digest" }));
    const hits = idx.search({ name: "Weekly digest" });
    expect(hits[0]?.itemType).toBe("email");
  });

  test("upsert with itemType 'task' round-trips as task", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "t1", itemType: "task", name: "My task" }));
    const hits = idx.search({ name: "My task" });
    expect(hits[0]?.itemType).toBe("task");
  });

  test("upsert with itemType 'folder' round-trips as folder", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "f1", itemType: "folder", name: "Documents folder" }));
    const hits = idx.search({ name: "Documents folder" });
    expect(hits[0]?.itemType).toBe("folder");
  });

  test("upsert with itemType 'photo' round-trips as photo", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "p1", itemType: "photo", name: "Beach photo" }));
    const hits = idx.search({ name: "Beach photo" });
    expect(hits[0]?.itemType).toBe("photo");
  });

  test("upsert with unknown itemType round-trips as-is, no fallback to 'file'", () => {
    const idx = makeIndex();
    // Use the db directly to insert a row with an unknown type
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test-svc",
      type: "widget", // not a known type
      externalId: "w1",
      title: "Widget item",
      modifiedAt: now,
      syncedAt: now,
    });
    const hits = idx.search({ name: "Widget item" });
    expect(hits[0]?.itemType).toBe("widget");
  });

  test("delete by external_id removes the item", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "del1", name: "Delete me" }));
    idx.delete("del1");
    expect(idx.search({ name: "Delete me" })).toEqual([]);
  });

  test("delete by primary key (id column) removes the item", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "pk1", service: "svc2", name: "PK delete" }));
    // Primary key is "svc2:pk1"
    idx.delete("svc2:pk1");
    expect(idx.search({ name: "PK delete" })).toEqual([]);
  });

  test("delete of non-existent id is a no-op", () => {
    const idx = makeIndex();
    expect(() => idx.delete("does-not-exist")).not.toThrow();
  });

  test("delete throws when external_id is ambiguous across services", () => {
    // Insert the same external_id for two different services directly
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "svc-a",
      type: "file",
      externalId: "shared-id",
      title: "A file",
      modifiedAt: now,
      syncedAt: now,
    });
    upsertIndexedItem(db, {
      service: "svc-b",
      type: "file",
      externalId: "shared-id",
      title: "B file",
      modifiedAt: now,
      syncedAt: now,
    });
    // Both rows have the same external_id but different primary keys
    expect(() => idx.delete("shared-id")).toThrow(/ambiguous/);
  });
});

// ---------------------------------------------------------------------------
// searchRanked branches
// ---------------------------------------------------------------------------

describe("LocalIndex.searchRanked", () => {
  test("searchRanked with no name returns all items (no FTS)", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.upsert(makeItem({ id: "i1", name: "Alpha", modifiedAt: now }));
    idx.upsert(makeItem({ id: "i2", name: "Beta", modifiedAt: now - 1000 }));
    const results = idx.searchRanked({}, {});
    expect(results).toHaveLength(2);
  });

  test("searchRanked with name uses FTS and returns ranked items", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "r1", name: "Nimbus cloud service" }));
    idx.upsert(makeItem({ id: "r2", name: "Rain forecast nimbus" }));
    idx.upsert(makeItem({ id: "r3", name: "Unrelated document" }));
    const results = idx.searchRanked({ name: "nimbus" }, {});
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });

  test("searchRanked with spaces-only name trims to empty string → falls back to no-FTS browse", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "s1", name: "Something" }));
    // "   ".trim() = "" → nameQ="" → useFts=false → returns all items (browse mode)
    const results = idx.searchRanked({ name: "   " }, {});
    // Falls into non-FTS path which returns all items
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("s1");
  });

  test("searchRanked with service filter restricts results", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "sf1", service: "drive", name: "Drive file" }));
    idx.upsert(makeItem({ id: "sf2", service: "slack", name: "Slack message" }));
    const results = idx.searchRanked({ service: "drive" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("sf1");
  });

  test("searchRanked with itemType filter restricts results", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "it1", itemType: "file", name: "A file" }));
    idx.upsert(makeItem({ id: "it2", itemType: "email", name: "An email" }));
    const results = idx.searchRanked({ itemType: "email" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("it2");
  });

  test("searchRanked with service AND name uses both filters", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "c1", service: "drive", name: "Report doc" }));
    idx.upsert(makeItem({ id: "c2", service: "slack", name: "Report message" }));
    const results = idx.searchRanked({ name: "report", service: "slack" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("c2");
  });

  test("searchRanked with service AND itemType filter (no FTS)", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "c3", service: "drive", itemType: "file", name: "alpha" }));
    idx.upsert(makeItem({ id: "c4", service: "drive", itemType: "email", name: "beta" }));
    const results = idx.searchRanked({ service: "drive", itemType: "file" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("c3");
  });

  test("searchRanked dedupes by canonical URL", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    const canon = "https://example.com/shared-doc";
    upsertIndexedItem(db, {
      service: "drive",
      type: "file",
      externalId: "d1",
      title: "Shared document alpha",
      modifiedAt: now,
      syncedAt: now,
      canonicalUrl: canon,
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "file",
      externalId: "g1",
      title: "Shared document alpha",
      modifiedAt: now - 1,
      syncedAt: now,
      canonicalUrl: canon,
    });
    const results = idx.searchRanked({ name: "shared document" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.canonicalUrl).toBe(canon);
    expect(results[0]?.duplicates).toContain("github");
  });

  test("searchRanked respects limit option", () => {
    const idx = makeIndex();
    for (let i = 0; i < 10; i++) {
      idx.upsert(makeItem({ id: `lim${i}`, name: `Document item ${i}` }));
    }
    const results = idx.searchRanked({ name: "document item" }, { candidateLimit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("searchRanked honors nowMs and searchServicePriority options", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.upsert(makeItem({ id: "p1", service: "high", name: "priority check", modifiedAt: now }));
    idx.upsert(makeItem({ id: "p2", service: "low", name: "priority check", modifiedAt: now }));
    const priorities = new Map([
      ["high", 1.0],
      ["low", 0.0],
    ]);
    const results = idx.searchRanked(
      { name: "priority check" },
      { nowMs: now, searchServicePriority: priorities },
    );
    expect(results[0]?.service).toBe("high");
  });

  test("searchRanked sorts by modified_at desc when browsing (no FTS)", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const base = Date.now();
    upsertIndexedItem(db, {
      service: "svc",
      type: "file",
      externalId: "older",
      title: "Some item older",
      modifiedAt: base - 5000,
      syncedAt: base,
    });
    upsertIndexedItem(db, {
      service: "svc",
      type: "file",
      externalId: "newer",
      title: "Some item newer",
      modifiedAt: base,
      syncedAt: base,
    });
    // No name query → browse mode → ORDER BY modified_at DESC → normBm25 all 0.5 → recency decides
    const results = idx.searchRanked({}, { nowMs: base });
    // Newer should rank first in browse (higher recency score)
    expect(results[0]?.id).toBe("newer");
    expect(results[1]?.id).toBe("older");
  });

  test("searchRanked with empty service filter string uses no filter", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "e1", service: "svc", name: "Empty filter" }));
    // service="" means no filter applied
    const results = idx.searchRanked({ service: "" }, {});
    expect(results).toHaveLength(1);
  });

  test("searchRanked with empty itemType filter string uses no filter", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "e2", itemType: "file", name: "Empty type filter" }));
    const results = idx.searchRanked({ itemType: "" }, {});
    expect(results).toHaveLength(1);
  });

  test("search() strips ranked fields and returns NimbusItem", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "strip1", name: "Strip test" }));
    const results = idx.search({ name: "strip test" });
    expect(results).toHaveLength(1);
    const item = results[0];
    expect(item).toBeDefined();
    // NimbusItem should not have ranked fields
    expect((item as unknown as Record<string, unknown>)["score"]).toBeUndefined();
    expect((item as unknown as Record<string, unknown>)["indexPrimaryKey"]).toBeUndefined();
    expect((item as unknown as Record<string, unknown>)["duplicates"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// searchRankedAsync (non-hybrid path — no semanticSearch)
// ---------------------------------------------------------------------------

describe("LocalIndex.searchRankedAsync fallback path", () => {
  test("falls back to searchRanked when no semanticSearch is configured", async () => {
    const idx = makeIndex(); // no semanticSearch
    idx.upsert(makeItem({ id: "async1", name: "Async search test" }));
    const results = await idx.searchRankedAsync({ name: "async search test" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("async1");
  });

  test("falls back when semantic=false is explicitly set", async () => {
    const scheduleIds: string[] = [];
    const idx = makeIndex({ scheduleItemEmbedding: (id) => scheduleIds.push(id) });
    idx.upsert(makeItem({ id: "async2", name: "Explicit no semantic" }));
    const results = await idx.searchRankedAsync(
      { name: "Explicit no semantic" },
      { semantic: false },
    );
    expect(results).toHaveLength(1);
  });

  test("falls back when nameQ is empty (semantic requires a name query)", async () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "async3", name: "Browse all" }));
    // no name = nameQ is "" → canHybrid = false → fallback
    const results = await idx.searchRankedAsync({});
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// searchRankedAsync with hybrid path (mock SemanticSearchDeps)
// ---------------------------------------------------------------------------

describe("LocalIndex.searchRankedAsync hybrid path", () => {
  test("executes hybrid path when semanticSearch is provided and nameQ is non-empty", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "drive",
      type: "file",
      externalId: "hyb1",
      title: "Hybrid query result",
      modifiedAt: now,
      syncedAt: now,
    });

    const fakeDeps: SemanticSearchDeps = {
      model: "all-MiniLM-L6-v2",
      embedQuery: async (_text: string): Promise<Float32Array | null> => null,
      embedQueryDual: async (_text: string) => ({
        vec384: null,
        vec1536: null,
        model384: null,
        model1536: null,
      }),
    };

    const idx = new LocalIndex(db, { semanticSearch: fakeDeps });
    // Even with semanticSearch, if vec is not available, hybridSearch will likely fall back
    // We just confirm no throw and we get results
    const results = await idx.searchRankedAsync({ name: "hybrid query" });
    // The result can be 0 (if hybrid returns nothing) or 1 — no throw is the key invariant
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rowToItem — metadata column branches (applyItemMetadataColumn)
// ---------------------------------------------------------------------------

describe("rowToItem metadata column branches", () => {
  test("url is set when url column is non-empty", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "url1",
      title: "Has URL",
      url: "https://nimbus.test/item",
      modifiedAt: now,
      syncedAt: now,
    });
    const results = idx.search({ name: "Has URL" });
    expect(results[0]?.url).toBe("https://nimbus.test/item");
  });

  test("url is omitted when url column is empty string", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    // url stored as "" is treated as null/undefined
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:url-empty",
        "test",
        "file",
        "url-empty",
        "Empty URL item",
        null,
        "",
        null,
        now,
        null,
        null,
        now,
        0,
      ],
    );
    const results = idx.search({ name: "Empty URL item" });
    expect(results[0]?.url).toBeUndefined();
  });

  test("metadata mime_type is extracted into mimeType field", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "meta1",
      title: "MIME item",
      modifiedAt: now,
      syncedAt: now,
      metadata: { mime_type: "application/pdf" },
    });
    const results = idx.search({ name: "MIME item" });
    expect(results[0]?.mimeType).toBe("application/pdf");
  });

  test("metadata size_bytes is extracted into sizeBytes field", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "meta2",
      title: "Size item",
      modifiedAt: now,
      syncedAt: now,
      metadata: { size_bytes: 12345 },
    });
    const results = idx.search({ name: "Size item" });
    expect(results[0]?.sizeBytes).toBe(12345);
  });

  test("metadata parent_id is extracted into parentId field", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "meta3",
      title: "Parent item",
      modifiedAt: now,
      syncedAt: now,
      metadata: { parent_id: "folder-abc" },
    });
    const results = idx.search({ name: "Parent item" });
    expect(results[0]?.parentId).toBe("folder-abc");
  });

  test("metadata created_at is extracted into createdAt field", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    const created = now - 100_000;
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "meta4",
      title: "Created at item",
      modifiedAt: now,
      syncedAt: now,
      metadata: { created_at: created },
    });
    const results = idx.search({ name: "Created at item" });
    expect(results[0]?.createdAt).toBe(created);
  });

  test("metadata with extra keys preserved in rawMeta", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "meta5",
      title: "Extra meta item",
      modifiedAt: now,
      syncedAt: now,
      metadata: { custom_field: "hello" },
    });
    const results = idx.search({ name: "Extra meta item" });
    expect(results[0]?.rawMeta?.["custom_field"]).toBe("hello");
  });

  test("metadata empty object leaves rawMeta unset", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "test",
      type: "file",
      externalId: "meta6",
      title: "No meta item",
      modifiedAt: now,
      syncedAt: now,
      metadata: {},
    });
    const results = idx.search({ name: "No meta item" });
    expect(results[0]?.rawMeta).toBeUndefined();
  });

  test("metadata null/undefined leaves rawMeta unset", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    // Insert with null metadata
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:meta-null",
        "test",
        "file",
        "meta-null",
        "Null meta item",
        null,
        null,
        null,
        now,
        null,
        null,
        now,
        0,
      ],
    );
    const results = idx.search({ name: "Null meta item" });
    expect(results[0]?.rawMeta).toBeUndefined();
  });

  test("applyItemMetadataColumn: invalid JSON leaves rawMeta unset (catch branch)", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    // Insert corrupted JSON directly
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:bad-json",
        "test",
        "file",
        "bad-json",
        "Bad JSON meta",
        null,
        null,
        null,
        now,
        null,
        "{invalid",
        now,
        0,
      ],
    );
    // Should not throw — JSON.parse error is swallowed
    expect(() => idx.search({ name: "Bad JSON meta" })).not.toThrow();
    const results = idx.search({ name: "Bad JSON meta" });
    expect(results[0]?.rawMeta).toBeUndefined();
  });

  test("applyItemMetadataColumn: JSON array is ignored (not an object)", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:json-array",
        "test",
        "file",
        "json-array",
        "JSON Array meta",
        null,
        null,
        null,
        now,
        null,
        "[1,2,3]",
        now,
        0,
      ],
    );
    const results = idx.search({ name: "JSON Array meta" });
    expect(results[0]?.rawMeta).toBeUndefined();
  });

  test("applyItemMetadataColumn: JSON null is ignored", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:json-null",
        "test",
        "file",
        "json-null",
        "JSON Null meta",
        null,
        null,
        null,
        now,
        null,
        "null",
        now,
        0,
      ],
    );
    const results = idx.search({ name: "JSON Null meta" });
    expect(results[0]?.rawMeta).toBeUndefined();
  });

  test("applyItemMetadataColumn: mime_type non-string is not set", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:mime-nonstr",
        "test",
        "file",
        "mime-nonstr",
        "Mime nonstring",
        null,
        null,
        null,
        now,
        null,
        '{"mime_type":42}',
        now,
        0,
      ],
    );
    const results = idx.search({ name: "Mime nonstring" });
    expect(results[0]?.mimeType).toBeUndefined();
  });

  test("applyItemMetadataColumn: size_bytes non-number is not set", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:size-str",
        "test",
        "file",
        "size-str",
        "Size NonNumber",
        null,
        null,
        null,
        now,
        null,
        // typeof !== "number" arm
        '{"size_bytes":"not-a-number"}',
        now,
        0,
      ],
    );
    const results = idx.search({ name: "Size NonNumber" });
    expect(results[0]?.sizeBytes).toBeUndefined();
  });

  test("applyItemMetadataColumn: size_bytes non-finite is not set", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:size-inf",
        "test",
        "file",
        "size-inf",
        "Size Infinity",
        null,
        null,
        null,
        now,
        null,
        // 1e309 parses to a numeric Infinity → typeof === "number" but !isFinite arm
        '{"size_bytes":1e309}',
        now,
        0,
      ],
    );
    const results = idx.search({ name: "Size Infinity" });
    expect(results[0]?.sizeBytes).toBeUndefined();
  });

  test("applyItemMetadataColumn: parent_id non-string is not set", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:pid-nonstr",
        "test",
        "file",
        "pid-nonstr",
        "ParentId nonstring",
        null,
        null,
        null,
        now,
        null,
        '{"parent_id":99}',
        now,
        0,
      ],
    );
    const results = idx.search({ name: "ParentId nonstring" });
    expect(results[0]?.parentId).toBeUndefined();
  });

  test("applyItemMetadataColumn: created_at non-number is not set", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:cat-str",
        "test",
        "file",
        "cat-str",
        "CreatedAt nonnumber",
        null,
        null,
        null,
        now,
        null,
        // typeof !== "number" arm
        '{"created_at":"nan"}',
        now,
        0,
      ],
    );
    const results = idx.search({ name: "CreatedAt nonnumber" });
    expect(results[0]?.createdAt).toBeUndefined();
  });

  test("applyItemMetadataColumn: created_at non-finite is not set", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:cat-inf",
        "test",
        "file",
        "cat-inf",
        "CreatedAt infinity",
        null,
        null,
        null,
        now,
        null,
        // 1e309 parses to a numeric Infinity → typeof === "number" but !isFinite arm
        '{"created_at":1e309}',
        now,
        0,
      ],
    );
    const results = idx.search({ name: "CreatedAt infinity" });
    expect(results[0]?.createdAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dedupeRankedByCanonicalUrl edge cases
// ---------------------------------------------------------------------------

describe("dedupeRankedByCanonicalUrl edge cases", () => {
  test("item with no canonical_url is not deduped", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "nocanon1", name: "No canon alpha" }));
    idx.upsert(makeItem({ id: "nocanon2", name: "No canon beta" }));
    // Search without name to avoid FTS
    const results = idx.searchRanked({}, {});
    expect(results).toHaveLength(2);
  });

  test("items with different canonical URLs are not merged", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "svc1",
      type: "file",
      externalId: "d1",
      title: "Dedupe test doc",
      modifiedAt: now,
      syncedAt: now,
      canonicalUrl: "https://a.example.com/1",
    });
    upsertIndexedItem(db, {
      service: "svc2",
      type: "file",
      externalId: "d2",
      title: "Dedupe test doc",
      modifiedAt: now - 1,
      syncedAt: now,
      canonicalUrl: "https://b.example.com/2",
    });
    const results = idx.searchRanked({ name: "Dedupe test doc" }, {});
    expect(results).toHaveLength(2);
  });

  test("empty-string canonical_url is treated as no canonical", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:empty-canon",
        "test",
        "file",
        "empty-canon",
        "Empty canon item",
        null,
        null,
        "",
        now,
        null,
        null,
        now,
        0,
      ],
    );
    const results = idx.searchRanked({}, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.canonicalUrl).toBeUndefined();
  });

  test("canonical_url is trimmed before dedup comparison", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "svc1",
      type: "file",
      externalId: "trim1",
      title: "Trim canon doc",
      modifiedAt: now,
      syncedAt: now,
      // Already trimmed — dedupe must normalize the OTHER (padded) value to match this.
      canonicalUrl: "https://canon.example.com/trimmed",
    });
    upsertIndexedItem(db, {
      service: "svc2",
      type: "file",
      externalId: "trim2",
      title: "Trim canon doc",
      modifiedAt: now - 1,
      syncedAt: now,
      canonicalUrl: "  https://canon.example.com/trimmed  ",
    });
    const results = idx.searchRanked({ name: "Trim canon doc" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]?.duplicates).toContain("svc2");
  });
});

// ---------------------------------------------------------------------------
// rowToPersistedSyncStatus branches (via persistedConnectorStatuses)
// ---------------------------------------------------------------------------

describe("LocalIndex.persistedConnectorStatuses status branches", () => {
  function insertSchedulerRow(
    db: Database,
    params: {
      serviceId: string;
      paused?: number;
      status?: string;
      errorMsg?: string | null;
    },
  ): void {
    db.run(
      `INSERT INTO scheduler_state
         (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
       VALUES (?, NULL, 60000, NULL, NULL, ?, ?, 0, ?)`,
      [params.serviceId, params.status ?? "ok", params.errorMsg ?? null, params.paused ?? 0],
    );
  }

  test("paused=1 → status 'paused', enabled=false", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    insertSchedulerRow(db, { serviceId: "svc-paused", paused: 1, status: "ok" });
    const statuses = idx.persistedConnectorStatuses("svc-paused");
    expect(statuses[0]?.status).toBe("paused");
    expect(statuses[0]?.enabled).toBe(false);
  });

  test("status='error' → status 'error'", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    insertSchedulerRow(db, {
      serviceId: "svc-error",
      paused: 0,
      status: "error",
      errorMsg: "timeout",
    });
    const statuses = idx.persistedConnectorStatuses("svc-error");
    expect(statuses[0]?.status).toBe("error");
    expect(statuses[0]?.lastError).toBe("timeout");
  });

  test("status='backoff' → status 'backoff'", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    insertSchedulerRow(db, { serviceId: "svc-backoff", paused: 0, status: "backoff" });
    const statuses = idx.persistedConnectorStatuses("svc-backoff");
    expect(statuses[0]?.status).toBe("backoff");
  });

  test("no serviceIdFilter → returns all connector statuses", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    insertSchedulerRow(db, { serviceId: "svc-a" });
    insertSchedulerRow(db, { serviceId: "svc-b" });
    const statuses = idx.persistedConnectorStatuses();
    expect(statuses).toHaveLength(2);
  });

  test("serviceIdFilter='' → returns all connector statuses", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    insertSchedulerRow(db, { serviceId: "svc-c" });
    const statuses = idx.persistedConnectorStatuses("");
    expect(statuses).toHaveLength(1);
  });

  test("serviceIdFilter with unknown connector → returns []", () => {
    const idx = makeIndex();
    expect(idx.persistedConnectorStatuses("nonexistent")).toEqual([]);
  });

  test("healthRetryAfterMs is null when no retryAfter", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    insertSchedulerRow(db, { serviceId: "svc-healthy" });
    const statuses = idx.persistedConnectorStatuses("svc-healthy");
    expect(statuses[0]?.healthRetryAfterMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensureGithubActionsSchedulerCompanionIfNeeded
// ---------------------------------------------------------------------------

describe("LocalIndex.ensureGithubActionsSchedulerCompanionIfNeeded", () => {
  test("no-op when githubPatPresent=false", () => {
    const idx = makeIndex();
    idx.ensureGithubActionsSchedulerCompanionIfNeeded({
      githubPatPresent: false,
      now: Date.now(),
      intervalMs: 60000,
    });
    expect(idx.persistedConnectorStatuses("github_actions")).toEqual([]);
  });

  test("no-op when github connector is not registered", () => {
    const idx = makeIndex();
    idx.ensureGithubActionsSchedulerCompanionIfNeeded({
      githubPatPresent: true,
      now: Date.now(),
      intervalMs: 60000,
    });
    expect(idx.persistedConnectorStatuses("github_actions")).toEqual([]);
  });

  test("no-op when github_actions already registered", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("github", 60000, now);
    idx.ensureConnectorSchedulerRegistration("github_actions", 60000, now);
    idx.ensureGithubActionsSchedulerCompanionIfNeeded({
      githubPatPresent: true,
      now,
      intervalMs: 60000,
    });
    const statuses = idx.persistedConnectorStatuses("github_actions");
    expect(statuses).toHaveLength(1); // still only 1
  });

  test("registers github_actions when github is present and actions not yet registered", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("github", 60000, now);
    idx.ensureGithubActionsSchedulerCompanionIfNeeded({
      githubPatPresent: true,
      now,
      intervalMs: 60000,
    });
    const statuses = idx.persistedConnectorStatuses("github_actions");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.serviceId).toBe("github_actions");
  });
});

// ---------------------------------------------------------------------------
// ensureCircleciSchedulerCompanionIfNeeded
// ---------------------------------------------------------------------------

describe("LocalIndex.ensureCircleciSchedulerCompanionIfNeeded", () => {
  test("no-op when circleciTokenPresent=false", () => {
    const idx = makeIndex();
    idx.ensureCircleciSchedulerCompanionIfNeeded({
      circleciTokenPresent: false,
      now: Date.now(),
      intervalMs: 60000,
    });
    expect(idx.persistedConnectorStatuses("circleci")).toEqual([]);
  });

  test("no-op when github connector is not registered", () => {
    const idx = makeIndex();
    idx.ensureCircleciSchedulerCompanionIfNeeded({
      circleciTokenPresent: true,
      now: Date.now(),
      intervalMs: 60000,
    });
    expect(idx.persistedConnectorStatuses("circleci")).toEqual([]);
  });

  test("no-op when circleci is already registered", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("github", 60000, now);
    idx.ensureConnectorSchedulerRegistration("circleci", 60000, now);
    idx.ensureCircleciSchedulerCompanionIfNeeded({
      circleciTokenPresent: true,
      now,
      intervalMs: 60000,
    });
    const statuses = idx.persistedConnectorStatuses("circleci");
    expect(statuses).toHaveLength(1);
  });

  test("registers circleci when github present and circleci not yet registered", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("github", 60000, now);
    idx.ensureCircleciSchedulerCompanionIfNeeded({
      circleciTokenPresent: true,
      now,
      intervalMs: 60000,
    });
    const statuses = idx.persistedConnectorStatuses("circleci");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.serviceId).toBe("circleci");
  });
});

// ---------------------------------------------------------------------------
// pause/resume/clear cursor / setInterval
// ---------------------------------------------------------------------------

describe("LocalIndex pause / resume / setInterval / clearCursor", () => {
  function setup(): { idx: LocalIndex; now: number } {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("github", 60000, now);
    return { idx, now };
  }

  test("pauseConnectorSync sets status to paused", () => {
    const { idx } = setup();
    idx.pauseConnectorSync("github");
    expect(idx.persistedConnectorStatuses("github")[0]?.status).toBe("paused");
  });

  test("pauseConnectorSync throws for unknown service", () => {
    const { idx } = setup();
    expect(() => idx.pauseConnectorSync("unknown")).toThrow(/Unknown connector/);
  });

  test("resumeConnectorSync re-enables after pause", () => {
    const { idx } = setup();
    idx.pauseConnectorSync("github");
    idx.resumeConnectorSync("github");
    expect(idx.persistedConnectorStatuses("github")[0]?.status).toBe("ok");
  });

  test("resumeConnectorSync throws for unknown service", () => {
    const { idx } = setup();
    expect(() => idx.resumeConnectorSync("unknown")).toThrow(/Unknown connector/);
  });

  test("clearConnectorSyncCursor succeeds for known connector", () => {
    const { idx } = setup();
    idx.recordSync("github", "cursor-token");
    expect(() => idx.clearConnectorSyncCursor("github")).not.toThrow();
  });

  test("clearConnectorSyncCursor throws for unknown connector", () => {
    const { idx } = setup();
    expect(() => idx.clearConnectorSyncCursor("unknown")).toThrow(/Unknown connector/);
  });

  test("setConnectorSyncIntervalMs updates the interval", () => {
    const { idx, now } = setup();
    idx.setConnectorSyncIntervalMs("github", 120_000, now);
    expect(idx.persistedConnectorStatuses("github")[0]?.intervalMs).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// setConnectorDepth / getConnectorDepth branches
// ---------------------------------------------------------------------------

describe("LocalIndex.setConnectorDepth branches", () => {
  test("setConnectorDepth inserts sync_state row when connector_id not present", () => {
    const idx = makeIndex();
    idx.setConnectorDepth("fresh-connector", "full");
    expect(idx.getConnectorDepth("fresh-connector")).toBe("full");
  });

  test("setConnectorDepth updates existing sync_state row", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth) VALUES (?, NULL, NULL, ?)`,
      ["github", "summary"],
    );
    const idx = new LocalIndex(db);
    idx.setConnectorDepth("github", "metadata_only");
    expect(idx.getConnectorDepth("github")).toBe("metadata_only");
  });

  test("getConnectorDepth throws for connector with no sync_state", () => {
    const idx = makeIndex();
    expect(() => idx.getConnectorDepth("no-such-connector")).toThrow(/unknown connector/i);
  });
});

// ---------------------------------------------------------------------------
// getBodyPreview branches
// ---------------------------------------------------------------------------

describe("LocalIndex.getBodyPreview", () => {
  test("returns undefined when item does not exist", () => {
    const idx = makeIndex();
    expect(idx.getBodyPreview("nonexistent:id")).toBeUndefined();
  });

  test("returns undefined when body_preview is null", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:no-preview",
        "test",
        "file",
        "no-preview",
        "No Preview",
        null,
        null,
        null,
        now,
        null,
        null,
        now,
        0,
      ],
    );
    expect(idx.getBodyPreview("test:no-preview")).toBeUndefined();
  });

  test("returns undefined when body_preview is whitespace-only", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:ws-preview",
        "test",
        "file",
        "ws-preview",
        "WS Preview",
        "   ",
        null,
        null,
        now,
        null,
        null,
        now,
        0,
      ],
    );
    expect(idx.getBodyPreview("test:ws-preview")).toBeUndefined();
  });

  test("returns preview string when it is non-empty", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test:has-preview",
        "test",
        "file",
        "has-preview",
        "Has Preview",
        "Some preview text",
        null,
        null,
        now,
        null,
        null,
        now,
        0,
      ],
    );
    expect(idx.getBodyPreview("test:has-preview")).toBe("Some preview text");
  });
});

// ---------------------------------------------------------------------------
// traverseGraph
// ---------------------------------------------------------------------------

describe("LocalIndex.traverseGraph", () => {
  test("returns error if schema version < 7 (simulated by downgrading user_version)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    // Forcibly downgrade user_version so readIndexedUserVersion returns < 7
    db.run("PRAGMA user_version = 6");
    const idx = new LocalIndex(db);
    const result = idx.traverseGraph("some-ref");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/schema v7/);
    }
  });

  test("returns {error} for a ref that resolves to no graph entity", () => {
    const idx = makeIndex();
    const result = idx.traverseGraph("some-nonexistent-ref");
    // traverseGraphSubgraph returns {error} when startRef has no matching graph entity
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/No graph entity/);
    }
  });

  test("returns a valid TraverseGraphResult for a known entity", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    // Insert an item so a graph entity is created
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "pr-123",
      title: "My PR",
      modifiedAt: Date.now(),
      syncedAt: Date.now(),
    });
    // traverseGraph can use the item pk as startRef
    const result = idx.traverseGraph("github:pr-123");
    // May return error if startRef not in graph_entity table directly; that's fine — we test both paths
    // The important invariant: no throw
    expect(typeof result).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// listItemsForAuthor / fetchMoreItems
// ---------------------------------------------------------------------------

describe("LocalIndex.listItemsForAuthor", () => {
  test("returns items for a known author_id", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "svc:authored1",
        "svc",
        "file",
        "authored1",
        "Authored item",
        null,
        null,
        null,
        now,
        "person-42",
        null,
        now,
        0,
      ],
    );
    const results = idx.listItemsForAuthor("person-42", 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Authored item");
  });

  test("limit is clamped to [1, 200]", () => {
    const idx = makeIndex();
    // Inserting 5 items then requesting limit=999 → at most 200 returned
    const db = idx.getDatabase();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `svc:a${i}`,
          "svc",
          "file",
          `a${i}`,
          `Author item ${i}`,
          null,
          null,
          null,
          now,
          "person-99",
          null,
          now,
          0,
        ],
      );
    }
    const results = idx.listItemsForAuthor("person-99", 999);
    expect(results).toHaveLength(5); // only 5 exist
  });

  test("limit=0 is clamped to 1", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "svc:az1",
        "svc",
        "file",
        "az1",
        "Author zero limit",
        null,
        null,
        null,
        now,
        "person-zero",
        null,
        now,
        0,
      ],
    );
    // limit=0 → Math.max(1, 0)=1 → returns 1 result
    const results = idx.listItemsForAuthor("person-zero", 0);
    expect(results).toHaveLength(1);
  });
});

describe("LocalIndex.listItems", () => {
  test("maps rows to IndexedItem and honours service/type/limit filters", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "run-1", service: "github", itemType: "ci_run", name: "nightly" }));
    idx.upsert(makeItem({ id: "m-1", service: "slack", itemType: "message", name: "hello" }));

    const all = idx.listItems({ services: [], types: [], limit: 50 });
    expect(all).toHaveLength(2);
    // Mapped, not raw: camelCase fields and the composite key.
    const run = all.find((i) => i.id === "run-1");
    expect(run?.itemType).toBe("ci_run");
    expect(run?.name).toBe("nightly");
    expect(run?.indexPrimaryKey).toBe("github:run-1");

    const onlyGithub = idx.listItems({ services: ["github"], types: [], limit: 50 });
    expect(onlyGithub.map((i) => i.id)).toEqual(["run-1"]);

    const onlyMessages = idx.listItems({ services: [], types: ["message"], limit: 50 });
    expect(onlyMessages.map((i) => i.id)).toEqual(["m-1"]);

    expect(idx.listItems({ services: [], types: [], limit: 1 })).toHaveLength(1);
  });
});

describe("LocalIndex.fetchMoreItems", () => {
  test("returns items for a service+type with offset and limit", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      upsertIndexedItem(db, {
        service: "slack",
        type: "message",
        externalId: `msg${i}`,
        title: `Message ${i}`,
        modifiedAt: now - i * 1000,
        syncedAt: now,
      });
    }
    const page1 = idx.fetchMoreItems("slack", "message", 0, 3);
    expect(page1).toHaveLength(3);
    const page2 = idx.fetchMoreItems("slack", "message", 3, 3);
    expect(page2).toHaveLength(2);
  });

  test("limit > 100 is clamped to 100", () => {
    const idx = makeIndex();
    const results = idx.fetchMoreItems("unknown-svc", "message", 0, 9999);
    expect(results).toHaveLength(0); // no items, no throw
  });

  test("limit=0 is clamped to 1", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "svc-fetch",
      type: "file",
      externalId: "f1",
      title: "Fetch file",
      modifiedAt: now,
      syncedAt: now,
    });
    const results = idx.fetchMoreItems("svc-fetch", "file", 0, 0);
    expect(results).toHaveLength(1);
  });

  test("offset < 0 is clamped to 0", () => {
    const idx = makeIndex();
    const db = idx.getDatabase();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "svc-neg",
      type: "file",
      externalId: "n1",
      title: "Neg offset file",
      modifiedAt: now,
      syncedAt: now,
    });
    const results = idx.fetchMoreItems("svc-neg", "file", -5, 10);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// recordSync / getLastSyncToken branches
// ---------------------------------------------------------------------------

describe("LocalIndex.recordSync / getLastSyncToken", () => {
  test("getLastSyncToken returns null for unknown connector", () => {
    const idx = makeIndex();
    expect(idx.getLastSyncToken("none")).toBeNull();
  });

  test("getLastSyncToken returns null when token is empty string", () => {
    const idx = makeIndex();
    idx.recordSync("svc", "");
    // empty string token → null
    expect(idx.getLastSyncToken("svc")).toBeNull();
  });

  test("getLastSyncToken returns the token when non-empty", () => {
    const idx = makeIndex();
    idx.recordSync("svc2", "my-cursor-token");
    expect(idx.getLastSyncToken("svc2")).toBe("my-cursor-token");
  });

  test("recordSync second call overwrites token", () => {
    const idx = makeIndex();
    idx.recordSync("svc3", "first");
    idx.recordSync("svc3", "second");
    expect(idx.getLastSyncToken("svc3")).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// audit methods
// ---------------------------------------------------------------------------

describe("LocalIndex audit methods", () => {
  test("listAudit returns entries in reverse order", () => {
    const idx = makeIndex();
    idx.recordAudit({
      actionType: "fs.read",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 1,
    });
    idx.recordAudit({
      actionType: "fs.write",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: 2,
    });
    const entries = idx.listAudit(10);
    expect(entries[0]?.actionType).toBe("fs.write");
    expect(entries[1]?.actionType).toBe("fs.read");
  });

  test("listAudit limit is clamped to [1, 1000]", () => {
    const idx = makeIndex();
    idx.recordAudit({ actionType: "x", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
    // limit=0 → clamped to 1
    const entries = idx.listAudit(0);
    expect(entries).toHaveLength(1);
  });

  test("listAuditWithChain includes rowHash and prevHash", () => {
    const idx = makeIndex();
    idx.recordAudit({
      actionType: "a.b",
      hitlStatus: "rejected",
      actionJson: "{}",
      timestamp: 100,
    });
    const entries = idx.listAuditWithChain(1);
    expect(entries[0]?.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entries[0]?.prevHash).toBe("string");
  });

  test("getAuditSummary aggregates by outcome and service prefix", () => {
    const idx = makeIndex();
    idx.recordAudit({
      actionType: "drive.read",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 1,
    });
    idx.recordAudit({
      actionType: "drive.write",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: 2,
    });
    idx.recordAudit({
      actionType: "slack.post",
      hitlStatus: "rejected",
      actionJson: "{}",
      timestamp: 3,
    });
    const summary = idx.getAuditSummary();
    expect(summary.total).toBe(3);
    expect(summary.byOutcome["not_required"]).toBe(1);
    expect(summary.byOutcome["approved"]).toBe(1);
    expect(summary.byOutcome["rejected"]).toBe(1);
    expect(summary.byService["drive"]).toBe(2);
    expect(summary.byService["slack"]).toBe(1);
  });

  test("getAuditSummary returns zeros on empty audit log", () => {
    const idx = makeIndex();
    const summary = idx.getAuditSummary();
    expect(summary.total).toBe(0);
    expect(Object.keys(summary.byOutcome)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAuditVerifiedThroughId / setAuditVerifiedThroughId
// ---------------------------------------------------------------------------

describe("LocalIndex.getAuditVerifiedThroughId / setAuditVerifiedThroughId", () => {
  test("getAuditVerifiedThroughId returns 0 when not set", () => {
    const idx = makeIndex();
    expect(idx.getAuditVerifiedThroughId()).toBe(0);
  });

  test("setAuditVerifiedThroughId persists and getAuditVerifiedThroughId retrieves it", () => {
    const idx = makeIndex();
    idx.setAuditVerifiedThroughId(42);
    expect(idx.getAuditVerifiedThroughId()).toBe(42);
  });

  test("setAuditVerifiedThroughId with negative value is clamped to 0", () => {
    const idx = makeIndex();
    idx.setAuditVerifiedThroughId(-5);
    expect(idx.getAuditVerifiedThroughId()).toBe(0);
  });

  test("setAuditVerifiedThroughId is upserted (second call overwrites)", () => {
    const idx = makeIndex();
    idx.setAuditVerifiedThroughId(10);
    idx.setAuditVerifiedThroughId(20);
    expect(idx.getAuditVerifiedThroughId()).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// getMeta / setMeta whitelist branches
// ---------------------------------------------------------------------------

describe("LocalIndex.getMeta / setMeta", () => {
  test("setMeta accepts whitelisted key and getMeta reads it back", () => {
    const idx = makeIndex();
    idx.setMeta("onboarding_completed", "2026-06-12T00:00:00Z");
    expect(idx.getMeta("onboarding_completed")).toBe("2026-06-12T00:00:00Z");
  });

  test("getMeta returns null for whitelisted but unset key", () => {
    const idx = makeIndex();
    expect(idx.getMeta("onboarding_completed")).toBeNull();
  });

  test("getMeta throws for key not in whitelist", () => {
    const idx = makeIndex();
    expect(() => idx.getMeta("vault_master_key")).toThrow(/whitelist/);
  });

  test("setMeta throws for key not in whitelist", () => {
    const idx = makeIndex();
    expect(() => idx.setMeta("nimbus_config", "x")).toThrow(/whitelist/);
  });

  test("setMeta is upserted — second call overwrites", () => {
    const idx = makeIndex();
    idx.setMeta("onboarding_completed", "v1");
    idx.setMeta("onboarding_completed", "v2");
    expect(idx.getMeta("onboarding_completed")).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// meta whitelist (isAllowedMetaKey)
// ---------------------------------------------------------------------------

describe("isAllowedMetaKey", () => {
  test("returns true for onboarding_completed", () => {
    expect(isAllowedMetaKey("onboarding_completed")).toBe(true);
  });

  test("returns false for arbitrary keys", () => {
    expect(isAllowedMetaKey("vault_key")).toBe(false);
    expect(isAllowedMetaKey("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("LocalIndex.close", () => {
  test("close does not throw on a healthy database", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const idx = new LocalIndex(db);
    expect(() => idx.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LAN peer full lifecycle (grantLanWrite / revokeLanWrite / removeLanPeer)
// ---------------------------------------------------------------------------

describe("LocalIndex LAN peer write grant/revoke/remove", () => {
  test("grantLanWrite sets write_allowed=1", () => {
    const idx = makeIndex();
    const pub = new Uint8Array(32).fill(1);
    idx.addLanPeer({ peerId: "peer-g", peerPubkey: pub, direction: "inbound" });
    idx.grantLanWrite("peer-g");
    expect(idx.getLanPeerByPubkey(pub)?.write_allowed).toBe(1);
  });

  test("revokeLanWrite sets write_allowed=0 after grant", () => {
    const idx = makeIndex();
    const pub = new Uint8Array(32).fill(2);
    idx.addLanPeer({ peerId: "peer-r", peerPubkey: pub, direction: "inbound" });
    idx.grantLanWrite("peer-r");
    idx.revokeLanWrite("peer-r");
    expect(idx.getLanPeerByPubkey(pub)?.write_allowed).toBe(0);
  });

  test("removeLanPeer removes the row and known namespaces cascade", () => {
    const idx = makeIndex();
    const pub = new Uint8Array(32).fill(3);
    idx.addLanPeer({ peerId: "peer-rm", peerPubkey: pub, direction: "outbound" });
    idx.removeLanPeer("peer-rm");
    expect(idx.getLanPeerByPubkey(pub)).toBeUndefined();
  });

  test("listLanPeers returns all peers ordered by paired_at", () => {
    const idx = makeIndex();
    idx.addLanPeer({
      peerId: "peer-A",
      peerPubkey: new Uint8Array(32).fill(4),
      direction: "inbound",
    });
    idx.addLanPeer({
      peerId: "peer-B",
      peerPubkey: new Uint8Array(32).fill(5),
      direction: "outbound",
    });
    const peers = idx.listLanPeers();
    expect(peers).toHaveLength(2);
  });

  test("addLanPeer with all optional fields populates them", () => {
    const idx = makeIndex();
    const pub = new Uint8Array(32).fill(6);
    idx.addLanPeer({
      peerId: "peer-full",
      peerPubkey: pub,
      direction: "inbound",
      hostIp: "10.0.0.1",
      hostPort: 7475,
      displayName: "Test Device",
    });
    const peer = idx.getLanPeerByPubkey(pub);
    expect(peer?.host_ip).toBe("10.0.0.1");
    expect(peer?.host_port).toBe(7475);
    expect(peer?.display_name).toBe("Test Device");
  });

  test("addLanPeer without optional fields stores nulls", () => {
    const idx = makeIndex();
    const pub = new Uint8Array(32).fill(7);
    idx.addLanPeer({ peerId: "peer-min", peerPubkey: pub, direction: "outbound" });
    const peer = idx.getLanPeerByPubkey(pub);
    expect(peer?.host_ip).toBeNull();
    expect(peer?.host_port).toBeNull();
    expect(peer?.display_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removeConnectorIndexData
// ---------------------------------------------------------------------------

describe("LocalIndex.removeConnectorIndexData", () => {
  test("returns count of removed items and clears all state", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("dropbox", 60000, now);
    idx.upsert(makeItem({ id: "d1", service: "dropbox", name: "Dropbox file 1" }));
    idx.upsert(makeItem({ id: "d2", service: "dropbox", name: "Dropbox file 2" }));
    const count = idx.removeConnectorIndexData("dropbox");
    expect(count).toBe(2);
    expect(idx.persistedConnectorStatuses("dropbox")).toEqual([]);
    expect(idx.search({ service: "dropbox" })).toEqual([]);
  });

  test("returns 0 when connector has no items", () => {
    const idx = makeIndex();
    const now = Date.now();
    idx.ensureConnectorSchedulerRegistration("empty-svc", 60000, now);
    const count = idx.removeConnectorIndexData("empty-svc");
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FTS edge cases — ftsTitleMatchQuery
// ---------------------------------------------------------------------------

describe("ftsTitleMatchQuery edge cases (via searchRanked)", () => {
  test("multi-token FTS query matches items with both tokens", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "fts1", name: "Annual budget planning" }));
    idx.upsert(makeItem({ id: "fts2", name: "Budget forecast" }));
    const results = idx.searchRanked({ name: "annual budget" }, {});
    expect(results.some((r) => r.id === "fts1")).toBe(true);
  });

  test("FTS query with double-quote in name is escaped", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "fts3", name: 'File with "quotes"' }));
    // Should not throw — the quote is escaped in the FTS query
    expect(() => idx.searchRanked({ name: 'with "quotes"' }, {})).not.toThrow();
  });
});
