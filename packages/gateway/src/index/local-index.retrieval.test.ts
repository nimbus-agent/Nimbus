/**
 * The disclosure is built INSIDE `searchRankedAsync`, against a real index with real vec0 rows —
 * not asserted on `retrievalFromOutcome` alone, which would pass even if `searchRankedAsync` never
 * called it. The seed mirrors `local-index.score-components.test.ts`, which proves this shape
 * really enters the hybrid branch.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { DualVectorsOutcome } from "../embedding/embedding-readiness.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { LocalIndex, type SemanticSearchDeps } from "./local-index.ts";
import type { BackfillPassProgress } from "./search-retrieval.ts";

const MODEL = "vec-test-model";

function seed(
  outcome: (q: Float32Array) => DualVectorsOutcome,
  backfill: BackfillPassProgress | null = null,
): { idx: LocalIndex; db: Database } {
  const db = new Database(":memory:");
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
  const v = new Float32Array(384);
  v[0] = 1;
  db.run("INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))", [1n, v]);
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, 0, 'rate limiting for the api', 1, ?, 384, ?)`,
    ["github:acme/api#1", MODEL, now],
  );
  const q = new Float32Array(384);
  q[0] = 1;
  const deps: SemanticSearchDeps = {
    model: MODEL,
    embedQuery: async () => q,
    embedQueryDualOutcome: async () => outcome(q),
    activeBackfillPass: () => backfill,
  };
  return { idx: new LocalIndex(db, { semanticSearch: deps }), db };
}

describe("searchRankedAsync discloses what it actually did", () => {
  test("a real query vector: vector-ranked, nothing to disclose", async () => {
    const { idx, db } = seed((q) => ({
      vectors: { vec384: q, vec1536: null, model384: MODEL, model1536: null },
      degraded: null,
    }));
    // Self-validating premise: without sqlite-vec on this connection the hybrid branch is never
    // entered and the assertion below would be testing the fallback instead.
    expect(db.query("select vec_version() as v").get()).toBeDefined();
    const { items, retrieval } = await idx.searchRankedAsync({ name: "rate limiting" });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.vectorRank).toBe(1);
    expect(retrieval).toEqual({ vectorRanked: true, reason: null, partial: null, backfill: null });
  });

  // The false claim this closes, stated as a test: the query embed timed out, the results are
  // keyword-only, and every item STILL says `scoringFormula: "hybrid_rrf"` — so nothing on the
  // items could ever have told a caller. Only the retrieval block does.
  test("a timed-out embed: keyword-only results that SAY so, while the items still claim hybrid", async () => {
    const { idx } = seed(() => ({
      vectors: { vec384: null, vec1536: null, model384: null, model1536: null },
      degraded: "timeout",
    }));
    const { items, retrieval } = await idx.searchRankedAsync({ name: "rate limiting" });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.scoringFormula).toBe("hybrid_rrf");
    expect(items[0]?.vectorRank ?? null).toBeNull();
    expect(retrieval).toEqual({
      vectorRanked: false,
      reason: "timeout",
      partial: null,
      backfill: null,
    });
  });

  test("warming is disclosed the same way", async () => {
    const { idx } = seed(() => ({
      vectors: { vec384: null, vec1536: null, model384: null, model1536: null },
      degraded: "warming",
    }));
    expect((await idx.searchRankedAsync({ name: "rate limiting" })).retrieval.reason).toBe(
      "warming",
    );
  });

  test("a running backfill pass is disclosed on BOTH branches", async () => {
    const pass = { done: 8400, total: 51600 };
    const { idx } = seed(
      (q) => ({
        vectors: { vec384: q, vec1536: null, model384: MODEL, model1536: null },
        degraded: null,
      }),
      pass,
    );
    expect((await idx.searchRankedAsync({ name: "rate limiting" })).retrieval.backfill).toEqual(
      pass,
    );
    const keywordOnly = await idx.searchRankedAsync({ name: "rate limiting" }, { semantic: false });
    expect(keywordOnly.retrieval).toEqual({
      vectorRanked: false,
      reason: "semantic_off",
      partial: null,
      backfill: pass,
    });
  });
});
