import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { LocalIndex, type SemanticSearchDeps } from "./local-index.ts";

// D30: any non-test file value-importing Database must name ensureFullSqlite. Tests do it too,
// so a fresh contributor copying this file into src/ does not reintroduce issue #1029.
ensureFullSqlite();

function seed(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  // `upsertIndexedItem` is a STANDALONE function in `item-store.ts` taking the Database —
  // `LocalIndex` has no such method, so `idx.upsertIndexedItem(...)` is a TypeError at runtime.
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/api#1",
    title: "rate limiting for the api",
    bodyPreview: "add a redis rate limiter",
    modifiedAt: now,
    syncedAt: now,
  });
  return idx;
}

describe("score components survive onto RankedIndexItem (spec §2.1)", () => {
  test("the FTS path reports fts_rank and all three components", () => {
    const idx = seed();
    const [item] = idx.searchRanked({ name: "rate", limit: 5 });
    expect(item).toBeDefined();
    expect(item?.scoringFormula).toBe("fts_rank");
    expect(typeof item?.matchScore).toBe("number");
    expect(typeof item?.recencyComponent).toBe("number");
    expect(typeof item?.servicePriorityComponent).toBe("number");
  });

  test("the components reconstruct the composite score (0.5/0.3/0.2)", () => {
    const idx = seed();
    const [item] = idx.searchRanked({ name: "rate", limit: 5 });
    const recomposed =
      0.5 * (item?.matchScore ?? 0) +
      0.3 * (item?.recencyComponent ?? 0) +
      0.2 * (item?.servicePriorityComponent ?? 0);
    // Exact, not approximate: these are the same floats compositeSearchScore combined.
    expect(recomposed).toBeCloseTo(item?.score ?? -1, 12);
  });
});

// ---------------------------------------------------------------------------
// Hybrid path (searchRankedAsync's `canHybrid` branch, spec §2.1/§2.2)
//
// Two prior rounds failed here: round 1 mocked `embedQueryDual` to return null vectors,
// which never enters the hybrid branch at all — `canHybrid` requires a non-null embedding
// to reach `hybridSearch`, so the assertion silently exercised the FTS fallback instead.
// Round 2 then claimed sqlite-vec is unavailable on Windows, which is false: it loads fine
// here (see .superpowers/sdd/2026-09-14-nimbus-explain-last/vecprobe.ts). The fix is to seed
// REAL vec0 rows exactly as `packages/gateway/src/search/hybrid.test.ts` already proves works
// end-to-end, and to drive `LocalIndex` itself (not `hybridSearch` directly) so the branch
// under test — `searchRankedAsync`'s component wiring — is the one actually exercised.
// ---------------------------------------------------------------------------

function seedHybrid(): { idx: LocalIndex; db: Database } {
  const db = new Database(":memory:");
  // `ensureSchema` runs every migration up to LocalIndex.SCHEMA_VERSION AND loads sqlite-vec
  // on this connection — the same call `hybrid.test.ts` relies on for its real-vector case.
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/api#1",
    title: "rate limiting for the api",
    bodyPreview: "add a redis rate limiter",
    modifiedAt: now,
    syncedAt: now,
  });

  // A real 384-dim vec0 row + its embedding_chunk pointer, seeded the same way
  // `hybrid.test.ts`'s "vector + BM25 RRF" case does — not a mock, a real indexed vector.
  const model = "vec-test-model";
  const v = new Float32Array(384);
  v[0] = 1;
  db.run("INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))", [1n, v]);
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, 0, 'rate limiting for the api', 1, ?, 384, ?)`,
    ["github:acme/api#1", model, now],
  );

  const q = new Float32Array(384);
  q[0] = 1;
  const fakeDeps: SemanticSearchDeps = {
    model,
    embedQuery: async () => q,
    // A real, non-null 384-dim query vector — the thing round 1 never provided, which is
    // exactly what kept `canHybrid` false and the hybrid branch unreached.
    embedQueryDualOutcome: async () => ({
      vectors: { vec384: q, vec1536: null, model384: model, model1536: null },
      degraded: null,
    }),
    activeBackfillPass: () => null,
  };

  return { idx: new LocalIndex(db, { semanticSearch: fakeDeps }), db };
}

describe("score components survive onto RankedIndexItem — hybrid path (spec §2.1)", () => {
  test("the hybrid path reports hybrid_rrf and all three components", async () => {
    const { idx, db } = seedHybrid();

    // Self-validating premise: sqlite-vec must actually be loaded on THIS connection, or
    // `ensureSqliteVecForConnection` would have failed and `canHybrid` would be false —
    // meaning the strict assertion below could never legitimately pass.
    expect(db.query("select vec_version() as v").get()).toBeDefined();

    const {
      items: [item],
    } = await idx.searchRankedAsync({ name: "rate limiting", limit: 5 }, { semantic: true });
    expect(item).toBeDefined();
    // Strict equality, not `["fts_rank", "hybrid_rrf"].toContain(...)`: if the hybrid
    // branch were not entered (or its `scoringFormula: "hybrid_rrf"` assignment were
    // deleted), this fails rather than passing on the FTS fallback's value.
    expect(item?.scoringFormula).toBe("hybrid_rrf");
    expect(typeof item?.matchScore).toBe("number");
    expect(typeof item?.recencyComponent).toBe("number");
    expect(typeof item?.servicePriorityComponent).toBe("number");
  });

  test("the hybrid components reconstruct the composite score (0.5/0.3/0.2)", async () => {
    const { idx, db } = seedHybrid();
    expect(db.query("select vec_version() as v").get()).toBeDefined();

    const {
      items: [item],
    } = await idx.searchRankedAsync({ name: "rate limiting", limit: 5 }, { semantic: true });
    expect(item?.scoringFormula).toBe("hybrid_rrf");
    const recomposed =
      0.5 * (item?.matchScore ?? 0) +
      0.3 * (item?.recencyComponent ?? 0) +
      0.2 * (item?.servicePriorityComponent ?? 0);
    expect(recomposed).toBeCloseTo(item?.score ?? -1, 12);
  });
});
