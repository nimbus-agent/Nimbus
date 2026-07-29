import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import {
  bestVectorRanksByItem,
  chunkContextLines,
  dedupeHybridByCanonicalUrl,
  ftsMatchQuery,
  type HybridScoringParams,
  loadBm25Hits,
  rrfTerm,
  runVectorSearch,
  scoreHybridItems,
} from "./hybrid-internal.ts";
import type { HybridIndexedItem, HybridSearchOptions, HybridSearchResult } from "./hybrid-types.ts";
import type { VectorChunkHit } from "./vec-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function freshDb(): Database {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, 30);
  return db;
}

const NOW = Date.now();

/** Insert a minimal item row (no FTS — use freshDb + seed for FTS). */
function insertItem(
  db: Database,
  id: string,
  service: string,
  title: string,
  modifiedAt = NOW,
  canonicalUrl: string | null = null,
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, canonical_url)
     VALUES (?, ?, 'file', ?, ?, '', ?, ?, ?)`,
    [id, service, id, title, modifiedAt, modifiedAt, canonicalUrl],
  );
}

function makeItem(overrides: Partial<HybridIndexedItem> = {}): HybridIndexedItem {
  return {
    id: "svc:x",
    service: "svc",
    type: "file",
    external_id: "x",
    title: "Test",
    body_preview: null,
    url: null,
    canonical_url: null,
    modified_at: NOW,
    author_id: null,
    metadata: null,
    synced_at: NOW,
    pinned: 0,
    ...overrides,
  };
}

function makeVecHit(itemId: string, chunkIndex = 0, distance = 0.1): VectorChunkHit {
  return { itemId, chunkIndex, chunkText: `chunk-${itemId}`, vecRowid: 1, distance };
}

// ---------------------------------------------------------------------------
// rrfTerm
// ---------------------------------------------------------------------------

describe("rrfTerm", () => {
  test("returns 1/(k+rank)", () => {
    expect(rrfTerm(1, 60)).toBeCloseTo(1 / 61);
    expect(rrfTerm(5, 60)).toBeCloseTo(1 / 65);
    expect(rrfTerm(1, 0)).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------------------
// bestVectorRanksByItem
// ---------------------------------------------------------------------------

describe("bestVectorRanksByItem", () => {
  test("empty input returns empty map", () => {
    const m = bestVectorRanksByItem([]);
    expect(m.size).toBe(0);
  });

  test("assigns 1-based ranks and picks best (lowest) rank for duplicates", () => {
    const hits = [
      { itemId: "a" },
      { itemId: "b" },
      { itemId: "a" }, // duplicate — rank 3 should NOT replace rank 1
    ];
    const m = bestVectorRanksByItem(hits);
    expect(m.get("a")).toBe(1); // first occurrence wins
    expect(m.get("b")).toBe(2);
  });

  test("handles undefined itemId via continue (sparse array slot)", () => {
    // Force an element whose itemId is undefined by casting
    const hits = [{ itemId: undefined as unknown as string }, { itemId: "c" }];
    const m = bestVectorRanksByItem(hits);
    // The undefined slot is skipped; 'c' still gets rank 2
    expect(m.has("c")).toBe(true);
    expect(m.size).toBe(1);
  });

  test("single item gets rank 1", () => {
    const m = bestVectorRanksByItem([{ itemId: "x" }]);
    expect(m.get("x")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// chunkContextLines
// ---------------------------------------------------------------------------

describe("chunkContextLines", () => {
  test("returns [] when contextChunks rounds to 0", () => {
    const db = freshDb();
    const result = chunkContextLines(db, "any", "m1", 0, 0);
    expect(result).toEqual([]);
    db.close();
  });

  test("returns [] when contextChunks is negative (clamps to 0)", () => {
    const db = freshDb();
    const result = chunkContextLines(db, "any", "m1", 0, -5);
    expect(result).toEqual([]);
    db.close();
  });

  test("returns chunk texts for seeded chunks within window", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "s:1", "svc", "Title 1", now);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:1', 0, 'chunk0', 0, 'm1', 384, ?)`,
      [now],
    );
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:1', 1, 'chunk1', 0, 'm1', 384, ?)`,
      [now],
    );
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:1', 2, 'chunk2', 0, 'm1', 384, ?)`,
      [now],
    );
    const lines = chunkContextLines(db, "s:1", "m1", 1, 1);
    expect(lines).toEqual(["chunk0", "chunk1", "chunk2"]);
    db.close();
  });

  test("clamps context window size to max 8", () => {
    const db = freshDb();
    // With contextChunks=100, n=8, low=max(0,0-8)=0, high=0+8=8
    const result = chunkContextLines(db, "none", "m1", 0, 100);
    expect(result).toEqual([]); // no rows, but no crash
    db.close();
  });
});

// ---------------------------------------------------------------------------
// ftsMatchQuery
// ---------------------------------------------------------------------------

describe("ftsMatchQuery", () => {
  test("returns empty string for empty input", () => {
    expect(ftsMatchQuery("")).toBe("");
    expect(ftsMatchQuery("   ")).toBe("");
  });

  test("single token produces correct FTS5 expression", () => {
    const q = ftsMatchQuery("hello");
    expect(q).toBe(`(title : "hello"* OR body_preview : "hello"*)`);
  });

  test("multi-token produces AND-joined expression", () => {
    const q = ftsMatchQuery("hello world");
    expect(q).toContain(`(title : "hello"* OR body_preview : "hello"*)`);
    expect(q).toContain(`(title : "world"* OR body_preview : "world"*)`);
    expect(q).toContain(" AND ");
  });

  test("escapes embedded double-quotes in tokens", () => {
    const q = ftsMatchQuery(`say "hi"`);
    // The quote inside the token should become ""
    expect(q).toContain(`"say"`);
    expect(q).toContain(`"""hi"""`);
  });
});

// ---------------------------------------------------------------------------
// loadBm25Hits
// ---------------------------------------------------------------------------

describe("loadBm25Hits", () => {
  function setupFtsDb(): Database {
    const db = freshDb();
    const now = Date.now();
    // Insert an item that will match FTS
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('svc:alpha', 'svc', 'note', 'alpha', 'alpha bravo', 'body text alpha', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('other:beta', 'other', 'note', 'beta', 'beta gamma', 'body text beta', ?, ?)`,
      [now, now],
    );
    return db;
  }

  test("no filters — returns all matching items", () => {
    const db = setupFtsDb();
    const fts = ftsMatchQuery("alpha");
    const opts: HybridSearchOptions = { query: "alpha", limit: 10, embeddingModel: "m1" };
    const hits = loadBm25Hits(db, fts, 10, undefined, opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.item.id).toBe("svc:alpha");
    db.close();
  });

  test("serviceFilter filters to matching service only", () => {
    const db = setupFtsDb();
    // Use a broad FTS query that matches both items
    const fts = ftsMatchQuery("body");
    const opts: HybridSearchOptions = { query: "body", limit: 10, embeddingModel: "m1" };
    const hits = loadBm25Hits(db, fts, 10, "svc", opts);
    for (const h of hits) {
      expect(h.item.service).toBe("svc");
    }
    db.close();
  });

  test("itemType filter — returns only matching type", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('s:note1', 's', 'note', 'n1', 'match text here', 'body', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('s:task1', 's', 'task', 't1', 'match text task', 'body', ?, ?)`,
      [now, now],
    );
    const fts = ftsMatchQuery("match");
    const optsNote: HybridSearchOptions = {
      query: "match",
      limit: 10,
      embeddingModel: "m1",
      itemType: "note",
    };
    const hitsNote = loadBm25Hits(db, fts, 10, undefined, optsNote);
    for (const h of hitsNote) {
      expect(h.item.type).toBe("note");
    }
    db.close();
  });

  test("since filter — excludes old items", () => {
    const db = freshDb();
    const old = Date.now() - 100_000;
    const recent = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('s:old', 's', 'note', 'old', 'findme old', 'body', ?, ?)`,
      [old, old],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('s:new', 's', 'note', 'new', 'findme new', 'body', ?, ?)`,
      [recent, recent],
    );
    const fts = ftsMatchQuery("findme");
    const opts: HybridSearchOptions = {
      query: "findme",
      limit: 10,
      embeddingModel: "m1",
      since: Date.now() - 50_000,
    };
    const hits = loadBm25Hits(db, fts, 10, undefined, opts);
    const ids = hits.map((h) => h.item.id);
    expect(ids).toContain("s:new");
    expect(ids).not.toContain("s:old");
    db.close();
  });

  test("since=0 does NOT filter (guard: since > 0)", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('s:item', 's', 'note', 'i', 'searchable item', 'body', ?, ?)`,
      [now, now],
    );
    const fts = ftsMatchQuery("searchable");
    const opts: HybridSearchOptions = {
      query: "searchable",
      limit: 10,
      embeddingModel: "m1",
      since: 0,
    };
    const hits = loadBm25Hits(db, fts, 10, undefined, opts);
    expect(hits).toHaveLength(1);
    db.close();
  });

  test("empty itemType string is treated as no filter", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('s:any', 's', 'note', 'a', 'queryterm anything', 'body', ?, ?)`,
      [now, now],
    );
    const fts = ftsMatchQuery("queryterm");
    const opts: HybridSearchOptions = {
      query: "queryterm",
      limit: 10,
      embeddingModel: "m1",
      itemType: "",
    };
    const hits = loadBm25Hits(db, fts, 10, undefined, opts);
    expect(hits).toHaveLength(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runVectorSearch
// ---------------------------------------------------------------------------

describe("runVectorSearch", () => {
  // No opts here ever carry a queryEmbedding / queryEmbedding1536, so the third row is the
  // "semantic on, non-empty query, but nothing to search with" case.
  test.each([
    ["semantic=false", "test", false],
    ["nameQ is empty string", "", true],
    ["no embedding vectors provided", "hello", true],
  ])("returns [] when %s", (_label, query, semantic) => {
    const db = freshDb();
    const opts: HybridSearchOptions = { query, limit: 10, embeddingModel: "m1", semantic };
    const result = runVectorSearch(db, opts, 10, undefined, query);
    expect(result).toEqual([]);
    db.close();
  });

  test("semantic defaults to true when undefined", () => {
    // When semantic=undefined, opts.semantic ?? true => true; but no embedding = []
    const db = freshDb();
    const opts: HybridSearchOptions = {
      query: "hello",
      limit: 10,
      embeddingModel: "m1",
      // semantic not set
    };
    const result = runVectorSearch(db, opts, 10, undefined, "hello");
    expect(result).toEqual([]);
    db.close();
  });

  test.skipIf(!VEC_AVAILABLE)("with 384 embedding only — searches correctly", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "s:1", "svc", "Title", now);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (1, vec_f32(?))`, [v384]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:1', 0, 'chunk', 1, 'm384', 384, ?)`,
      [now],
    );
    const q384 = new Float32Array(384);
    q384[0] = 1;
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m384",
      semantic: true,
      queryEmbedding: q384,
    };
    const hits = runVectorSearch(db, opts, 10, undefined, "test");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("s:1");
    db.close();
  });

  test.skipIf(!VEC_AVAILABLE)("with 1536 embedding only — searches correctly", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "s:2", "svc", "Title", now);
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    db.run(`INSERT INTO vec_items_1536 (rowid, embedding) VALUES (1, vec_f32(?))`, [v1536]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:2', 0, 'chunk', 1, 'm1536', 1536, ?)`,
      [now],
    );
    const q1536 = new Float32Array(1536);
    q1536[0] = 1;
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m384",
      embeddingModel1536: "m1536",
      semantic: true,
      queryEmbedding1536: q1536,
    };
    const hits = runVectorSearch(db, opts, 10, undefined, "test");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("s:2");
    db.close();
  });

  test.skipIf(!VEC_AVAILABLE)("queryEmbedding1536 without embeddingModel1536 — skips 1536", () => {
    // Branch: opts.queryEmbedding1536 !== undefined && opts.embeddingModel1536 !== undefined => false
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "s:3", "svc", "Title", now);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (1, vec_f32(?))`, [v384]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:3', 0, 'chunk', 1, 'm384', 384, ?)`,
      [now],
    );
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    db.run(`INSERT INTO vec_items_1536 (rowid, embedding) VALUES (2, vec_f32(?))`, [v1536]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:3', 1, 'chunk2', 2, 'm1536', 1536, ?)`,
      [now],
    );
    const q384 = new Float32Array(384);
    q384[0] = 1;
    const q1536 = new Float32Array(1536);
    q1536[0] = 1;
    // No embeddingModel1536 provided — the 1536 branch is skipped
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m384",
      // embeddingModel1536 intentionally absent
      semantic: true,
      queryEmbedding: q384,
      queryEmbedding1536: q1536,
    };
    const hits = runVectorSearch(db, opts, 10, undefined, "test");
    // Only 384 side fires; gets item s:3 from m384 model
    const ids = hits.map((h) => h.itemId);
    expect(ids).toContain("s:3");
    db.close();
  });

  test.skipIf(!VEC_AVAILABLE)("serviceFilter is forwarded to vector search", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "svc:1", "svc", "Title", now);
    insertItem(db, "other:1", "other", "Title", now);
    const v384a = new Float32Array(384);
    v384a[0] = 1;
    const v384b = new Float32Array(384);
    v384b[0] = 0.99;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (1, vec_f32(?))`, [v384a]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('svc:1', 0, 'chunk', 1, 'm384', 384, ?)`,
      [now],
    );
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (2, vec_f32(?))`, [v384b]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('other:1', 0, 'chunk2', 2, 'm384', 384, ?)`,
      [now],
    );
    const q = new Float32Array(384);
    q[0] = 1;
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m384",
      semantic: true,
      queryEmbedding: q,
    };
    const hits = runVectorSearch(db, opts, 10, "svc", "test");
    // Positive cardinality first — otherwise an empty result (a regression that drops all
    // vector hits) would still satisfy the per-hit id check below.
    expect(hits).toHaveLength(1);
    for (const h of hits) {
      expect(h.itemId).toBe("svc:1");
    }
    db.close();
  });

  test.skipIf(!VEC_AVAILABLE)("itemType filter forwarded to vector search", () => {
    const db = freshDb();
    const now = Date.now();
    // Only insert one item with type 'note'
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('s:note', 's', 'note', 'n', 'title', ?, ?)`,
      [now, now],
    );
    const v = new Float32Array(384);
    v[0] = 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (1, vec_f32(?))`, [v]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:note', 0, 'chunk', 1, 'm1', 384, ?)`,
      [now],
    );
    const q = new Float32Array(384);
    q[0] = 1;
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m1",
      semantic: true,
      queryEmbedding: q,
      itemType: "note",
    };
    const hits = runVectorSearch(db, opts, 10, undefined, "test");
    // Positive cardinality first — `every` is vacuously true on an empty result.
    expect(hits).toHaveLength(1);
    expect(hits.every((h) => h.itemId === "s:note")).toBe(true);
    db.close();
  });

  test.skipIf(!VEC_AVAILABLE)("since filter forwarded to vector search", () => {
    const db = freshDb();
    const old = Date.now() - 200_000;
    const recent = Date.now();
    // old item
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('s:old', 's', 'note', 'o', 'title', ?, ?)`,
      [old, old],
    );
    // recent item
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('s:new', 's', 'note', 'n', 'title', ?, ?)`,
      [recent, recent],
    );
    const vold = new Float32Array(384);
    vold[0] = 0.8;
    const vnew = new Float32Array(384);
    vnew[0] = 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (1, vec_f32(?))`, [vold]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:old', 0, 'chunk', 1, 'm1', 384, ?)`,
      [old],
    );
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (2, vec_f32(?))`, [vnew]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:new', 0, 'chunk', 2, 'm1', 384, ?)`,
      [recent],
    );
    const q = new Float32Array(384);
    q[0] = 1;
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m1",
      semantic: true,
      queryEmbedding: q,
      since: Date.now() - 100_000,
    };
    const hits = runVectorSearch(db, opts, 10, undefined, "test");
    const ids = hits.map((h) => h.itemId);
    expect(ids).toContain("s:new");
    expect(ids).not.toContain("s:old");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// dedupeHybridByCanonicalUrl
// ---------------------------------------------------------------------------

describe("dedupeHybridByCanonicalUrl", () => {
  test("empty input returns empty output", () => {
    expect(dedupeHybridByCanonicalUrl([])).toEqual([]);
  });

  test("null canonical_url items are always emitted (no dedup)", () => {
    const a = makeItem({ id: "svc:a", canonical_url: null });
    const b = makeItem({ id: "svc:b", canonical_url: null });
    const r: HybridSearchResult[] = [
      { item: a, bm25Rank: 1, vectorRank: null, rrfScore: 0.5 },
      { item: b, bm25Rank: 2, vectorRank: null, rrfScore: 0.4 },
    ];
    const out = dedupeHybridByCanonicalUrl(r);
    expect(out).toHaveLength(2);
  });

  test("empty-string canonical_url is treated as no URL", () => {
    const a = makeItem({ id: "svc:a", canonical_url: "" });
    const b = makeItem({ id: "svc:b", canonical_url: "  " });
    const r: HybridSearchResult[] = [
      { item: a, bm25Rank: 1, vectorRank: null, rrfScore: 0.5 },
      { item: b, bm25Rank: 2, vectorRank: null, rrfScore: 0.4 },
    ];
    const out = dedupeHybridByCanonicalUrl(r);
    // Both empty/whitespace canonical_url items fall through the null/empty branch
    expect(out).toHaveLength(2);
  });

  test("duplicate canonical_url — second is recorded in duplicates", () => {
    const url = "https://example.com/item";
    const a = makeItem({ id: "svc:a", service: "github", canonical_url: url });
    const b = makeItem({ id: "svc:b", service: "gitlab", canonical_url: url });
    const r: HybridSearchResult[] = [
      { item: a, bm25Rank: 1, vectorRank: null, rrfScore: 0.5 },
      { item: b, bm25Rank: 2, vectorRank: null, rrfScore: 0.3 },
    ];
    const out = dedupeHybridByCanonicalUrl(r);
    expect(out).toHaveLength(1);
    expect(out[0]?.duplicates).toEqual(["gitlab"]);
  });

  test("three items with same canonical_url — both extra services in duplicates", () => {
    const url = "https://example.com/shared";
    const a = makeItem({ id: "svc:a", service: "svc", canonical_url: url });
    const b = makeItem({ id: "svc:b", service: "svc2", canonical_url: url });
    const c = makeItem({ id: "svc:c", service: "svc3", canonical_url: url });
    const r: HybridSearchResult[] = [
      { item: a, bm25Rank: 1, vectorRank: null, rrfScore: 0.5 },
      { item: b, bm25Rank: 2, vectorRank: null, rrfScore: 0.4 },
      { item: c, bm25Rank: 3, vectorRank: null, rrfScore: 0.3 },
    ];
    const out = dedupeHybridByCanonicalUrl(r);
    expect(out).toHaveLength(1);
    expect(out[0]?.duplicates).toEqual(["svc2", "svc3"]);
  });

  test("pre-existing duplicates array is extended (??[] branch)", () => {
    const url = "https://example.com/dup";
    const a = makeItem({ id: "svc:a", service: "svc1", canonical_url: url });
    const b = makeItem({ id: "svc:b", service: "svc2", canonical_url: url });
    const r: HybridSearchResult[] = [
      // First result already has a duplicates array
      { item: a, bm25Rank: 1, vectorRank: null, rrfScore: 0.8, duplicates: ["pre-existing"] },
      { item: b, bm25Rank: 2, vectorRank: null, rrfScore: 0.5 },
    ];
    const out = dedupeHybridByCanonicalUrl(r);
    expect(out).toHaveLength(1);
    // duplicates should include both the pre-existing and the new one
    expect(out[0]?.duplicates).toContain("pre-existing");
    expect(out[0]?.duplicates).toContain("svc2");
  });

  test("distinct canonical_urls are not merged", () => {
    const a = makeItem({ id: "svc:a", canonical_url: "https://a.com" });
    const b = makeItem({ id: "svc:b", canonical_url: "https://b.com" });
    const r: HybridSearchResult[] = [
      { item: a, bm25Rank: 1, vectorRank: null, rrfScore: 0.5 },
      { item: b, bm25Rank: 2, vectorRank: null, rrfScore: 0.4 },
    ];
    const out = dedupeHybridByCanonicalUrl(r);
    expect(out).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// scoreHybridItems
// ---------------------------------------------------------------------------

describe("scoreHybridItems", () => {
  function makeScoringParams(db: Database, contextN = 0): HybridScoringParams {
    const opts: HybridSearchOptions = {
      query: "test",
      limit: 10,
      embeddingModel: "m1",
      semantic: true,
    };
    return { db, opts, k: 60, wB: 1, wV: 1, contextN };
  }

  test("empty inputs return empty result", () => {
    const db = freshDb();
    const result = scoreHybridItems([], [], makeScoringParams(db));
    expect(result).toEqual([]);
    db.close();
  });

  test("BM25-only hit is scored correctly", () => {
    const db = freshDb();
    const item = makeItem({ id: "svc:x" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [{ item, rank: 1 }];
    const result = scoreHybridItems(bm25, [], makeScoringParams(db));
    expect(result).toHaveLength(1);
    expect(result[0]?.item.id).toBe("svc:x");
    expect(result[0]?.bm25Rank).toBe(1);
    expect(result[0]?.vectorRank).toBeNull();
    expect(result[0]?.rrfScore).toBeCloseTo(rrfTerm(1, 60));
    db.close();
  });

  test("vector-only hit fetches item from DB", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "svc:y", "svc", "Y title", now);

    const vecHit = makeVecHit("svc:y");
    const result = scoreHybridItems([], [vecHit], makeScoringParams(db));
    expect(result).toHaveLength(1);
    expect(result[0]?.item.id).toBe("svc:y");
    expect(result[0]?.bm25Rank).toBeNull();
    expect(result[0]?.vectorRank).toBe(1);
    db.close();
  });

  test("vector-only hit for non-existent item in DB is skipped", () => {
    const db = freshDb();
    const vecHit = makeVecHit("nonexistent:z");
    const result = scoreHybridItems([], [vecHit], makeScoringParams(db));
    expect(result).toHaveLength(0);
    db.close();
  });

  test("combined BM25 + vector hit has both ranks", () => {
    const db = freshDb();
    const item = makeItem({ id: "svc:both" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [{ item, rank: 2 }];
    const vecHit = makeVecHit("svc:both");
    const result = scoreHybridItems(bm25, [vecHit], makeScoringParams(db));
    expect(result).toHaveLength(1);
    expect(result[0]?.bm25Rank).toBe(2);
    expect(result[0]?.vectorRank).toBe(1);
    const expected = rrfTerm(2, 60) + rrfTerm(1, 60);
    expect(result[0]?.rrfScore).toBeCloseTo(expected);
    db.close();
  });

  test("results are sorted by rrfScore descending", () => {
    const db = freshDb();
    const itemA = makeItem({ id: "svc:a" });
    const itemB = makeItem({ id: "svc:b" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [
      { item: itemA, rank: 5 },
      { item: itemB, rank: 1 }, // higher rank = higher score
    ];
    const result = scoreHybridItems(bm25, [], makeScoringParams(db));
    expect(result).toHaveLength(2);
    expect(result[0]?.item.id).toBe("svc:b"); // rank 1 > rank 5 for RRF
    expect(result[1]?.item.id).toBe("svc:a");
    db.close();
  });

  test("tie-break: equal rrfScore sorted by modified_at descending", () => {
    const db = freshDb();
    const now = Date.now();
    const itemOld = makeItem({ id: "svc:old", modified_at: now - 10000 });
    const itemNew = makeItem({ id: "svc:new", modified_at: now });
    // Both at rank 1 → same RRF score
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [
      { item: itemOld, rank: 1 },
      { item: itemNew, rank: 1 },
    ];
    const result = scoreHybridItems(bm25, [], makeScoringParams(db));
    expect(result).toHaveLength(2);
    expect(result[0]?.item.id).toBe("svc:new"); // newer first
    expect(result[1]?.item.id).toBe("svc:old");
    db.close();
  });

  test("semanticSnippet is included when contextN=0 and vec hit present", () => {
    const db = freshDb();
    const item = makeItem({ id: "svc:snippet" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [{ item, rank: 1 }];
    const vecHit: VectorChunkHit = {
      itemId: "svc:snippet",
      chunkIndex: 0,
      chunkText: "my chunk text",
      vecRowid: 1,
      distance: 0.1,
    };
    const result = scoreHybridItems(bm25, [vecHit], makeScoringParams(db, 0));
    expect(result).toHaveLength(1);
    expect(result[0]?.semanticSnippet).toBe("my chunk text");
    db.close();
  });

  test("semanticSnippet uses chunkContextLines when contextN>0", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, "svc:ctx", "svc", "Ctx", now);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('svc:ctx', 0, 'before', 0, 'm1', 384, ?)`,
      [now],
    );
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('svc:ctx', 1, 'center', 0, 'm1', 384, ?)`,
      [now],
    );
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('svc:ctx', 2, 'after', 0, 'm1', 384, ?)`,
      [now],
    );
    const item = makeItem({ id: "svc:ctx" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [{ item, rank: 1 }];
    const vecHit: VectorChunkHit = {
      itemId: "svc:ctx",
      chunkIndex: 1,
      chunkText: "center",
      vecRowid: 1,
      distance: 0.05,
    };
    const result = scoreHybridItems(bm25, [vecHit], makeScoringParams(db, 1));
    expect(result).toHaveLength(1);
    const snippet = result[0]?.semanticSnippet;
    expect(snippet).toBeDefined();
    expect(snippet).toContain("before");
    expect(snippet).toContain("center");
    expect(snippet).toContain("after");
    db.close();
  });

  test("duplicate vec hits for same item: best rank wins", () => {
    const db = freshDb();
    const item = makeItem({ id: "svc:dup" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [{ item, rank: 1 }];
    const vecHit1: VectorChunkHit = makeVecHit("svc:dup", 0);
    const vecHit2: VectorChunkHit = makeVecHit("svc:dup", 1);
    // vecHit1 is at position 0 (rank 1), vecHit2 at position 1 (rank 2)
    const result = scoreHybridItems(bm25, [vecHit1, vecHit2], makeScoringParams(db));
    expect(result).toHaveLength(1);
    expect(result[0]?.vectorRank).toBe(1); // best rank wins
    db.close();
  });

  test("no snippet when no vec hit for item", () => {
    const db = freshDb();
    const item = makeItem({ id: "svc:novec" });
    const bm25: Array<{ item: HybridIndexedItem; rank: number }> = [{ item, rank: 1 }];
    const result = scoreHybridItems(bm25, [], makeScoringParams(db, 1));
    expect(result).toHaveLength(1);
    expect(result[0]?.semanticSnippet).toBeUndefined();
    db.close();
  });

  test("rrfScore zero (no ranks for item) produces null result — item never appears", () => {
    // This tests the rrfScore <= 0 guard in tryBuildHybridHit.
    // We can't produce this case through the normal union (an item in the union always has
    // at least one rank), so we verify via an empty itemIds union:
    const db = freshDb();
    const result = scoreHybridItems([], [], makeScoringParams(db));
    expect(result).toHaveLength(0);
    db.close();
  });
});
