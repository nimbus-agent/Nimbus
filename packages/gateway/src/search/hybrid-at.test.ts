import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { buildAtClause } from "../index/item-history-at.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { hybridSearch } from "./hybrid.ts";
import { vectorCandidateLimit } from "./hybrid-internal.ts";

function put(db: Database, ext: string, title: string, opened: number, at: number): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: ext,
    title,
    modifiedAt: at,
    syncedAt: at,
    metadata: { state: "open", opened_at_ms: opened },
  });
}

describe("hybridSearch with an --at clause", () => {
  test("the BM25 arm admits only items that existed at T", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    put(db, "seed", "unrelated", 90, 100);
    put(db, "old", "payment-service retry fix", 150, 200);
    put(db, "late", "payment-service payment-service rewrite", 1200, 1300);
    const base = { query: "payment-service", limit: 10, semantic: false, embeddingModel: "m" };
    expect(
      hybridSearch(db, base)
        .map((r) => r.item.external_id)
        .sort(),
    ).toEqual(["late", "old"]);
    const then = hybridSearch(db, { ...base, at: buildAtClause(db, 1000, "i") });
    expect(then.map((r) => r.item.external_id)).toEqual(["old"]);
  });
});

describe("vectorCandidateLimit", () => {
  test("the vector arm asks for the maximum k under --at and limit*25 otherwise", () => {
    expect(vectorCandidateLimit(10, false)).toBe(250);
    expect(vectorCandidateLimit(40, false)).toBe(500);
    expect(vectorCandidateLimit(10, true)).toBe(500);
    expect(vectorCandidateLimit(1, true)).toBe(500);
  });
});
