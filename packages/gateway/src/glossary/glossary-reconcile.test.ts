import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { upsertIndexedItem } from "../index/item-store.ts";
import { projectTerm } from "./glossary-project.ts";
import { reconcilePass } from "./glossary-reconcile.ts";
import { getTerm, markConsolidated, upsertCandidate, upsertManualTerm } from "./glossary-store.ts";

let db: Database;

function seedItem(externalId: string, body: string, modifiedAt: number): void {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId,
    title: body,
    bodyPreview: body,
    modifiedAt,
    syncedAt: modifiedAt,
  });
}

function seedConsolidated(key: string, docFreq: number, nowMs = 1000): void {
  upsertCandidate(db, {
    key,
    surface: key.toUpperCase(),
    form: "acronym",
    stats: { docFreq, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 5,
    nowMs,
  });
  markConsolidated(db, {
    termKey: key,
    definition: "a definition",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs,
  });
  const t = getTerm(db, key);
  if (t !== null) projectTerm(db, t, nowMs);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("a term whose sources vanished is demoted and unprojected", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3);
  db.run("DELETE FROM item WHERE type = 'message'");

  const out = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });

  expect(out.demoted).toEqual(["cdr"]);
  expect(getTerm(db, "cdr")?.status).toBe("pending");
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all()).toHaveLength(0);
});

test("a term still above the floor keeps its definition and is re-stamped", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3);

  const out = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });

  expect(out.demoted).toEqual([]);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definition).toBe("a definition");
  expect(t?.statsVerifiedAt).toBe(2000);
});

test("statistics are refreshed rather than left stale", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 99);
  reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });
  expect(getTerm(db, "cdr")?.docFreq).toBe(3);
});

test("a retained term's projected item is re-projected with its refreshed topSources", () => {
  // `seedConsolidated` projects with an EMPTY topSources (its stats.topSources
  // is always `[]`) — real citing items exist only in `item_fts`. A sweep must
  // pick them up and write them into the projected item's metadata, not just
  // into the `glossary_term` row.
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3);

  const before = db.query("SELECT metadata FROM item WHERE type = 'glossary_term'").get() as {
    metadata: string;
  } | null;
  expect(JSON.parse(before?.metadata ?? "{}").topSources).toEqual([]);

  reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });

  const after = db.query("SELECT metadata FROM item WHERE type = 'glossary_term'").get() as {
    metadata: string;
  } | null;
  const topSources = JSON.parse(after?.metadata ?? "{}").topSources as unknown[];
  expect(topSources).toHaveLength(3);
});

test("the sweep honours its limit", () => {
  seedItem("a", "CDR one AAA BBB", 100);
  seedConsolidated("cdr", 3, 1000);
  seedConsolidated("aaa", 3, 1000);
  seedConsolidated("bbb", 3, 1000);
  expect(reconcilePass(db, { limit: 2, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 }).verified).toBe(
    2,
  );
});

test("the sweep is a no-op on an empty glossary", () => {
  const out = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });
  expect(out).toEqual({ verified: 0, demoted: [] });
});

test("round-robin reaches a different term on the next pass", () => {
  seedItem("a", "CDR one AAA", 100);
  seedConsolidated("cdr", 3, 1000);
  seedConsolidated("aaa", 3, 1000);
  reconcilePass(db, { limit: 1, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });
  reconcilePass(db, { limit: 1, minDocFreq: 3, nowMs: 3000, cooldownMs: 0 });
  expect(getTerm(db, "cdr")?.statsVerifiedAt).toBeGreaterThan(1000);
  expect(getTerm(db, "aaa")?.statsVerifiedAt).toBeGreaterThan(1000);
});

test("the cooldown makes a repeat sweep a no-op", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3, 1000);

  const first = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 100_000, cooldownMs: 1000 });
  expect(first.verified).toBe(1);

  // Immediately after: the term was just verified, so nothing is due.
  const second = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 100_500, cooldownMs: 1000 });
  expect(second.verified).toBe(0);

  // Once the cooldown lapses it becomes due again.
  const third = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 102_000, cooldownMs: 1000 });
  expect(third.verified).toBe(1);
});

test("demotion is atomic — a failure between the writes rolls all three back", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3);
  db.run("DELETE FROM item WHERE type = 'message'");

  const before = getTerm(db, "cdr");
  expect(before?.status).toBe("consolidated");

  // Simulates a crash exactly in the un-self-healing window the reviewer
  // found: after unprojectTerm's DELETE and demoteTerm's UPDATE have already
  // run, but before applyStats' UPDATE commits. A DB-level trigger fires
  // precisely on applyStats' write (score -> 0) and raises, so the first two
  // writes are genuinely applied (not merely "about to run") before the
  // failure — this is NOT wrapped in an outer transaction, so it exercises
  // reconcilePass's own `db.transaction()` and nothing else's.
  db.run(
    `CREATE TRIGGER simulated_crash_before_apply_stats
     BEFORE UPDATE OF score ON glossary_term
     WHEN NEW.score = 0
     BEGIN SELECT RAISE(ABORT, 'simulated crash before applyStats'); END`,
  );

  expect(() =>
    reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 }),
  ).toThrow();

  db.run("DROP TRIGGER simulated_crash_before_apply_stats");

  const after = getTerm(db, "cdr");
  expect(after?.status).toBe("consolidated");
  expect(after?.definition).toBe("a definition");
  expect(db.query("SELECT COUNT(*) AS c FROM item WHERE type = 'glossary_term'").get()).toEqual({
    c: 1,
  });
});

test("the sweep refreshes a manual row's stats but never demotes it", () => {
  // doc_freq is genuinely below the floor: no item in the index mentions it.
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 5, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 5,
    nowMs: 0,
  });

  const summary = reconcilePass(db, {
    limit: 50,
    minDocFreq: 3,
    nowMs: 1_000_000,
    cooldownMs: 0,
  });

  const t = getTerm(db, "cdr");
  // Order is load-bearing: `bun:test` halts a test body at its first failing
  // assertion. `status` is checked before `demoted` so that reverting the
  // `!isManual &&` guard surfaces the failure on the named assertion
  // (`status` stays 'consolidated') rather than on `summary.demoted`, which
  // would also fail under that mutation and mask it. Do not reorder this back.
  expect(t?.status).toBe("consolidated");
  expect(summary.demoted).not.toContain("cdr");
  expect(t?.definition).toBe("Authored.");
  expect(t?.definitionSource).toBe("manual");
  // Stats WERE re-measured — the stale 5 is corrected down to the real 0.
  expect(t?.docFreq).toBe(0);
  expect(t?.statsVerifiedAt).toBe(1_000_000);
});
