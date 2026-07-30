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
import { getTerm, markConsolidated, upsertCandidate } from "./glossary-store.ts";

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
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
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
