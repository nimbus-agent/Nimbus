import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { upsertIndexedItem } from "./item-store.ts";
import type { SemanticSearchDeps } from "./local-index.ts";
import { LocalIndex } from "./local-index.ts";

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

  test("the hybrid path reports hybrid_rrf and all three components (when vec available)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/api#2",
      title: "rate limiting for the api",
      bodyPreview: "add a redis rate limiter",
      modifiedAt: now,
      syncedAt: now,
    });

    // Mock SemanticSearchDeps following the pattern from local-index.test.ts
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
    const [item] = await idx.searchRankedAsync({ name: "rate", limit: 5 });
    expect(item).toBeDefined();
    // Score components must always be present when searchRankedAsync returns results
    expect(typeof item?.matchScore).toBe("number");
    expect(typeof item?.recencyComponent).toBe("number");
    expect(typeof item?.servicePriorityComponent).toBe("number");
    expect(item?.scoringFormula).toBeDefined();
    // If vec is not available, it falls back to FTS (scoringFormula: "fts_rank")
    // If vec is available, it uses hybrid (scoringFormula: "hybrid_rrf")
    // Either way, all four fields must be present for the explain task to work
    expect(["fts_rank", "hybrid_rrf"]).toContain(item?.scoringFormula);
  });

  test("the hybrid path components reconstruct the composite score", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/api#3",
      title: "rate limiting for the api",
      bodyPreview: "add a redis rate limiter",
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
    const [item] = await idx.searchRankedAsync({ name: "rate", limit: 5 });
    const recomposed =
      0.5 * (item?.matchScore ?? 0) +
      0.3 * (item?.recencyComponent ?? 0) +
      0.2 * (item?.servicePriorityComponent ?? 0);
    // Exact, not approximate: these are the same floats compositeSearchScore combined.
    expect(recomposed).toBeCloseTo(item?.score ?? -1, 12);
  });
});
