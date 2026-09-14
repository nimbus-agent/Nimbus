import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { buildLocalIndexedContextForTest } from "./run-ask.ts";

ensureFullSqlite();

function seedMany(n: number): LocalIndex {
  const db = new Database(":memory:");
  // Schema comes from the STATIC `LocalIndex.ensureSchema(db)` — there is no `idx.migrate()`
  // instance method. And `syncedAt` is REQUIRED by `upsertIndexedItem`'s input type; omitting it
  // is a typecheck failure, not a runtime default. (Both corrected during Task 1, which had the
  // same fixture shape.)
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    // Standalone function taking the Database — not a LocalIndex method (see Task 1).
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `slack:${String(i)}`,
      title: `rate limiting note ${String(i)}`,
      bodyPreview: "throttling discussion",
      modifiedAt: now - i * 1000,
      syncedAt: now,
    });
  }
  return idx;
}

describe("local-context capture (spec §4.4)", () => {
  test("the pool is wider than what reached the model, and names the probe-slice cut", async () => {
    // 40 matches, context limit 8 — so 32 are cut, and the cut that dominates is the slice
    // the primary probe applies BEFORE the cap and BEFORE fairness ever run.
    const out = await buildLocalIndexedContextForTest(seedMany(40), "rate limiting");
    expect(out).toBeDefined();
    const pool = out?.explain.pool ?? [];
    expect(pool.length).toBeGreaterThan(8);
    expect(pool.filter((c) => c.outcome === "shown").length).toBeLessThanOrEqual(8);
    expect(pool.some((c) => c.outcome === "cut: probe slice")).toBe(true);
  });

  test("every candidate names the pass that contributed it", () => {
    // Guards the §2.2 non-comparability story: without a pass, a renderer cannot know which
    // scores may be compared with which.
    return buildLocalIndexedContextForTest(seedMany(12), "rate limiting").then((out) => {
      for (const c of out?.explain.pool ?? []) expect(c.pass.kind).toBeTruthy();
    });
  });

  test("the discarded tail is grouped by service and type", async () => {
    const out = await buildLocalIndexedContextForTest(seedMany(40), "rate limiting");
    const tail = out?.explain.discardedTail ?? [];
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[0]?.service).toBe("slack");
    expect(tail[0]?.type).toBe("message");
  });

  test("a SHOWN candidate carries real score components, not undefined", async () => {
    // THE regression guard for this task. `byId` holds `Omit<LocalContextItem,"rank">`, and
    // `formatContextItem` drops score/components/scoringFormula — so an implementation that
    // reads them off a byId value yields undefined for every candidate, every row renders
    // "n/a (direct query)", and Task 1 is silently defeated. The other tests in this file all
    // pass in that world, because they assert on pass and outcome only.
    const out = await buildLocalIndexedContextForTest(seedMany(40), "rate limiting");
    const shown = (out?.explain.pool ?? []).filter((c) => c.outcome === "shown");
    expect(shown.length).toBeGreaterThan(0);
    for (const c of shown) {
      expect(c.scoringFormula).toBeDefined();
      expect(typeof c.score).toBe("number");
      expect(typeof c.matchScore).toBe("number");
      expect(typeof c.recencyComponent).toBe("number");
      expect(typeof c.servicePriorityComponent).toBe("number");
    }
  });

  test("title comes from RankedIndexItem.name — there is no .title on that type", async () => {
    const out = await buildLocalIndexedContextForTest(seedMany(5), "rate limiting");
    for (const c of out?.explain.pool ?? []) {
      expect(c.title).toContain("rate limiting note");
      expect(c.sourceId).not.toBe("undefined");
    }
  });

  test("multi-pass reconciliation: the pass recorded is the one that INSERTED the item", async () => {
    // This assertion belongs HERE, not in Task 3. `classifyCandidateOutcome` takes no `pass`
    // parameter at all, so multi-pass reconciliation is not expressible at that layer — it is
    // `passById`'s first-writer-wins, which lives in this task's wiring. Task 3 originally
    // carried a test named for this property that could not observe it; it was deleted.
    //
    // An item reachable by BOTH the primary probe and a quoted term must record the pass that
    // actually merged it (`addRankedResults`/`addContextItems` keep the FIRST writer via
    // `if (!byId.has(...))`), never the last one to match.
    const out = await buildLocalIndexedContextForTest(seedMany(12), 'rate limiting "throttling"');
    const pool = out?.explain.pool ?? [];
    const merged = pool.filter((c) => c.outcome !== "cut: probe slice");
    expect(merged.length).toBeGreaterThan(0);
    // Every merged candidate names exactly one pass, and an item the primary probe already
    // inserted is never re-attributed to the later quoted pass.
    for (const c of merged) {
      expect(c.pass.kind).toBeTruthy();
    }
    expect(merged.some((c) => c.pass.kind === "primary-hybrid")).toBe(true);
  });
});
