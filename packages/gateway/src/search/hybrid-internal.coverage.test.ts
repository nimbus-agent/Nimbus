/**
 * `scoreHybridItems` with a ZERO-weighted leg (`HybridSearchOptions.bm25Weight` /
 * `vectorWeight` are caller options, so 0 is a reachable value). An item that only the
 * zero-weighted leg found has a fused score of exactly 0 and must be DROPPED — not returned as a
 * "match" ranked below everything else with no evidence behind it. `hybrid-internal.test.ts`
 * always scores with both weights at 1, so it never reaches that refusal.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { type HybridScoringParams, rrfTerm, scoreHybridItems } from "./hybrid-internal.ts";
import type { HybridIndexedItem } from "./hybrid-types.ts";
import type { VectorChunkHit } from "./vec-store.ts";

const NOW = 1_760_000_000_000;

function item(id: string): HybridIndexedItem {
  return {
    id,
    service: "svc",
    type: "file",
    external_id: id,
    title: `title ${id}`,
    body_preview: null,
    url: null,
    canonical_url: null,
    modified_at: NOW,
    author_id: null,
    metadata: null,
    synced_at: NOW,
    pinned: 0,
  };
}

function vecHit(itemId: string): VectorChunkHit {
  return { itemId, chunkIndex: 0, chunkText: `chunk ${itemId}`, vecRowid: 1, distance: 0.2 };
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  // The vector-only item is looked up by id, so it has to exist in `item`.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES ('svc:vec-only', 'svc', 'file', 'vec-only', 'vector title', '', ?, ?)`,
    [NOW, NOW],
  );
});

afterEach(() => {
  db.close();
});

function params(wB: number, wV: number): HybridScoringParams {
  return {
    db,
    opts: { query: "q", limit: 10, embeddingModel: "m", semantic: true },
    k: 60,
    wB,
    wV,
    contextN: 0,
  };
}

describe("scoreHybridItems — a zero-weighted leg contributes no evidence", () => {
  test("bm25Weight 0: an item only BM25 found is dropped; the vector-found item survives", () => {
    const bm25 = [{ item: item("svc:bm25-only"), rank: 1 }];
    const out = scoreHybridItems(bm25, [vecHit("svc:vec-only")], params(0, 1));
    expect(out.map((r) => r.item.id)).toEqual(["svc:vec-only"]);
    expect(out[0]?.rrfScore).toBeCloseTo(rrfTerm(1, 60));
  });

  test("vectorWeight 0: an item only the vector leg found is dropped; the BM25-found item survives", () => {
    const bm25 = [{ item: item("svc:bm25-only"), rank: 1 }];
    const out = scoreHybridItems(bm25, [vecHit("svc:vec-only")], params(1, 0));
    expect(out.map((r) => r.item.id)).toEqual(["svc:bm25-only"]);
    expect(out[0]?.bm25Rank).toBe(1);
    expect(out[0]?.vectorRank).toBeNull();
  });

  test("an item BOTH legs found keeps the weighted leg's share even when the other weight is 0", () => {
    const bm25 = [{ item: item("svc:vec-only"), rank: 3 }];
    const out = scoreHybridItems(bm25, [vecHit("svc:vec-only")], params(0, 1));
    expect(out).toHaveLength(1);
    // Ranks are still reported for both legs; only the zero-weighted one adds nothing to the score.
    expect(out[0]?.bm25Rank).toBe(3);
    expect(out[0]?.vectorRank).toBe(1);
    expect(out[0]?.rrfScore).toBeCloseTo(rrfTerm(1, 60));
  });
});
