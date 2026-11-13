import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { buildAtClause } from "./item-history-at.ts";
import { buildItemListSql } from "./item-list-query.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { LocalIndex } from "./local-index.ts";

function makeIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

type Pr = { ext: string; title: string; opened: number; at: number; state?: string };

function putPr(db: Database, p: Pr): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: p.ext,
    title: p.title,
    modifiedAt: p.at,
    syncedAt: p.at,
    metadata: { state: p.state ?? "open", opened_at_ms: p.opened },
  });
}

const T = 1000;

/** history is covered (seed row at 100); an early PR; and a LATER PR that is the best match and newest. */
function seed(idx: LocalIndex): void {
  putPr(idx.rawDb, { ext: "seed", title: "unrelated", opened: 90, at: 100 });
  putPr(idx.rawDb, { ext: "old", title: "payment-service retry fix", opened: 150, at: 200 });
  putPr(idx.rawDb, {
    ext: "late",
    title: "payment-service payment-service payment-service rewrite",
    opened: 1200,
    at: 1300,
  });
}

describe("searchRanked with atMs", () => {
  test("the FTS path excludes an item created after T even if it is the best match and the newest", () => {
    const idx = makeIndex();
    seed(idx);
    const now = idx.searchRanked({ name: "payment-service", limit: 10 });
    expect(now.map((i) => i.id)).toContain("late");
    const then = idx.searchRanked({ name: "payment-service", limit: 10, atMs: T });
    expect(then.map((i) => i.id)).toEqual(["old"]);
    expect(then[0]?.asOf?.atMs).toBe(T);
    expect(then[0]?.asOf?.state["state"]).toBe("open");
  });

  test("the no-name browse path excludes it too, and composes with service and type", () => {
    const idx = makeIndex();
    seed(idx);
    const then = idx.searchRanked({ service: "github", itemType: "pr", limit: 10, atMs: T });
    expect(then.map((i) => i.id).sort()).toEqual(["old", "seed"]);
    expect(idx.searchRanked({ service: "gitlab", limit: 10, atMs: T })).toEqual([]);
  });

  test("a change after T is shown as the earlier state", () => {
    const idx = makeIndex();
    seed(idx);
    putPr(idx.rawDb, {
      ext: "old",
      title: "payment-service retry fix",
      opened: 150,
      at: 1500,
      state: "closed",
    });
    const then = idx.searchRanked({ name: "payment-service", limit: 10, atMs: T });
    expect(then[0]?.asOf).toMatchObject({ basis: "history", state: { state: "open" } });
  });

  test("no atMs: no asOf on any item", () => {
    const idx = makeIndex();
    seed(idx);
    const now = idx.searchRanked({ name: "payment-service", limit: 10 });
    expect(now.every((i) => i.asOf === undefined)).toBe(true);
  });
});

describe("searchRankedAsync with atMs", () => {
  test("with no embedding runtime it falls to the keyword path and returns the same admitted set", async () => {
    const idx = makeIndex();
    seed(idx);
    const r = await idx.searchRankedAsync({ name: "payment-service", limit: 10, atMs: T });
    expect(r.items.map((i) => i.id)).toEqual(["old"]);
    expect(r.items[0]?.asOf?.atMs).toBe(T);
  });
});

describe("fetchMoreItems with atMs", () => {
  test("pages only admitted items in modified_at DESC order", () => {
    const idx = makeIndex();
    seed(idx);
    const page = idx.fetchMoreItems("github", "pr", 0, 10, T);
    expect(page.map((i) => i.id)).toEqual(["old", "seed"]);
    expect(idx.fetchMoreItems("github", "pr", 0, 10).map((i) => i.id)).toEqual([
      "late",
      "old",
      "seed",
    ]);
    expect(idx.fetchMoreItems("github", "pr", 1, 10, T).map((i) => i.id)).toEqual(["seed"]);
  });
});

describe("buildItemListSql with at", () => {
  test("absent at leaves the SQL byte-identical to the plain query", () => {
    const base = buildItemListSql({ services: ["github"], types: ["pr"], limit: 5 });
    expect(base.sql).not.toContain("item_history");
    expect(base.vals).toEqual(["github", "pr", 5]);
  });

  test("at composes with services, types, ids and idInSql; params follow the filters and precede LIMIT", () => {
    const idx = makeIndex();
    seed(idx);
    const at = buildAtClause(idx.rawDb, T, "item");
    const { sql, vals } = buildItemListSql({
      services: ["github"],
      types: ["pr"],
      idInSql: { sql: "SELECT id FROM item WHERE title LIKE ?", vals: ["payment%"] },
      sinceMs: 0,
      at,
      limit: 7,
    });
    expect(vals.slice(0, 5)).toEqual(["github", "pr", "payment%", 0, ...at.params].slice(0, 5));
    expect(vals.slice(-1)).toEqual([7]);
    expect(vals).toHaveLength(4 + at.params.length + 1);
    const rows = idx.rawDb.query(sql).all(...vals) as { external_id: string }[];
    expect(rows.map((r) => r.external_id)).toEqual(["old"]);
    const withIds = buildItemListSql({ ids: ["github:old", "github:late"], at, limit: 3 });
    const got = idx.rawDb.query(withIds.sql).all(...withIds.vals) as { external_id: string }[];
    expect(got.map((r) => r.external_id)).toEqual(["old"]);
  });
});
