import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { dbRun } from "../db/write.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { upsertIndexedItem } from "../index/item-store.ts";
import {
  applyStats,
  clearGlossary,
  computeTermStats,
  countByStatus,
  demoteTerm,
  findBySynonym,
  getTerm,
  listAllKeys,
  listConsolidated,
  markConsolidated,
  markVetoed,
  readPassState,
  recordAttempt,
  retryCooldownMs,
  selectPendingBatch,
  selectSnippetUpgradeBatch,
  selectStaleForRecheck,
  upsertCandidate,
  writePassState,
} from "./glossary-store.ts";

let db: Database;

function seedItem(o: {
  externalId: string;
  service?: string;
  type?: string;
  title: string;
  body: string;
  modifiedAt: number;
}): void {
  upsertIndexedItem(db, {
    service: o.service ?? "slack",
    type: o.type ?? "message",
    externalId: o.externalId,
    title: o.title,
    bodyPreview: o.body,
    modifiedAt: o.modifiedAt,
    syncedAt: o.modifiedAt,
  });
}

function seedCandidate(key: string, score = 1): void {
  upsertCandidate(db, {
    key,
    surface: key.toUpperCase(),
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 100, lastSeenAt: 200, topSources: [] },
    score,
    nowMs: 1000,
  });
}

function consolidate(key: string, nowMs = 2000, synonyms: string[] = []): void {
  markConsolidated(db, {
    termKey: key,
    definition: "d",
    definitionSource: "llm",
    synonyms,
    nearMisses: [],
    nowMs,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("computeTermStats counts distinct citing items and services", () => {
  seedItem({ externalId: "a", title: "CDR rollout", body: "the CDR is live", modifiedAt: 100 });
  seedItem({ externalId: "b", title: "more CDR", body: "CDR again", modifiedAt: 300 });
  seedItem({
    externalId: "c",
    service: "jira",
    type: "issue",
    title: "CDR ticket",
    body: "CDR work",
    modifiedAt: 200,
  });
  const s = computeTermStats(db, "cdr");
  expect(s.docFreq).toBe(3);
  expect(s.serviceSpread).toBe(2);
  expect(s.firstSeenAt).toBe(100);
  expect(s.lastSeenAt).toBe(300);
});

test("computeTermStats ignores an allowlisted type carried by a non-allowlisted service", () => {
  // `issue` is an allowlisted BARE type (linear/jira/github/gitlab), but
  // `wiz:issue` is a cloud-security-posture finding, not team prose. Filtering
  // on the bare type alone would mine it — and, because service_spread is a
  // geometric multiplier in scoreTerm, inflate every term it mentions.
  seedItem({ externalId: "a", title: "CDR rollout", body: "the CDR is live", modifiedAt: 100 });
  seedItem({
    externalId: "w",
    service: "wiz",
    type: "issue",
    title: "CDR exposure",
    body: "CDR bucket is public",
    modifiedAt: 200,
  });
  const s = computeTermStats(db, "cdr");
  expect(s.docFreq).toBe(1);
  expect(s.serviceSpread).toBe(1);
  expect(s.topSources.map((t) => t.service)).toEqual(["slack"]);
});

test("computeTermStats returns at most five top sources", () => {
  for (let i = 0; i < 8; i++) {
    seedItem({ externalId: `i${String(i)}`, title: "CDR", body: "CDR here", modifiedAt: 100 + i });
  }
  expect(computeTermStats(db, "cdr").topSources.length).toBe(5);
});

test("computeTermStats is zero for an absent term", () => {
  expect(computeTermStats(db, "nosuchterm").docFreq).toBe(0);
});

test("computeTermStats ignores item types outside the source scope", () => {
  upsertIndexedItem(db, {
    service: "gmail",
    type: "email",
    externalId: "e1",
    title: "CDR in mail",
    bodyPreview: "CDR private",
    modifiedAt: 100,
    syncedAt: 100,
  });
  expect(computeTermStats(db, "cdr").docFreq).toBe(0);
});

test("computeTermStats drops to zero after the citing item is deleted", () => {
  seedItem({ externalId: "a", title: "CDR", body: "CDR", modifiedAt: 100 });
  expect(computeTermStats(db, "cdr").docFreq).toBe(1);
  db.run("DELETE FROM item");
  expect(computeTermStats(db, "cdr").docFreq).toBe(0);
});

test("upsertCandidate inserts pending and getTerm round-trips it", () => {
  seedCandidate("cdr");
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.displayTerm).toBe("CDR");
  expect(t?.docFreq).toBe(3);
});

test("upsertCandidate never downgrades a consolidated row", () => {
  seedCandidate("cdr");
  consolidate("cdr");
  seedCandidate("cdr");
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
});

test("a hyphenated term is matched (documented phrase-equivalence)", () => {
  seedItem({
    externalId: "h1",
    title: "caching",
    body: "we use write-behind caching",
    modifiedAt: 100,
  });
  seedItem({ externalId: "h2", title: "caching", body: "write-behind again", modifiedAt: 101 });
  expect(computeTermStats(db, "write-behind").docFreq).toBe(2);
});

test("hyphenated matching is phrase-equivalent — unhyphenated prose also counts", () => {
  // Asserts ACTUAL FTS5 unicode61 behaviour, not an ideal: `-` is a token
  // separator, so this is a phrase search for `write behind`. Documented in
  // `ftsQuery`. If this ever starts failing, the tokenizer changed.
  seedItem({
    externalId: "h1",
    title: "caching",
    body: "we use write-behind caching",
    modifiedAt: 100,
  });
  seedItem({
    externalId: "h2",
    title: "prose",
    body: "we write behind the scenes",
    modifiedAt: 101,
  });
  expect(computeTermStats(db, "write-behind").docFreq).toBe(2);
});

test("an underscored term is matched", () => {
  seedItem({ externalId: "u1", title: "keys", body: "set the shard_key first", modifiedAt: 100 });
  expect(computeTermStats(db, "shard_key").docFreq).toBe(1);
});

test("a term key with FTS-hostile characters degrades to zero, never throws", () => {
  expect(() => computeTermStats(db, 'we"ird^(term)')).not.toThrow();
});

const QUEUE = { nowMs: 10_000, retryBaseCooldownMs: 1000, minDocFreq: 0 };

test("markVetoed is sticky and keeps the row out of the pending batch", () => {
  seedCandidate("cdr");
  markVetoed(db, "cdr", 2000);
  expect(getTerm(db, "cdr")?.status).toBe("vetoed");
  expect(selectPendingBatch(db, 10, QUEUE).length).toBe(0);
});

test("selectPendingBatch orders by score descending and honours the limit", () => {
  seedCandidate("low", 1);
  seedCandidate("high", 9);
  seedCandidate("mid", 5);
  expect(selectPendingBatch(db, 2, QUEUE).map((t) => t.termKey)).toEqual(["high", "mid"]);
});

test("a freshly-attempted term is withheld while its backoff is active", () => {
  seedCandidate("high", 9);
  seedCandidate("low", 1);
  recordAttempt(db, "high", 10_000);
  const batch = selectPendingBatch(db, 10, {
    nowMs: 10_500,
    retryBaseCooldownMs: 1000,
    minDocFreq: 0,
  });
  expect(batch.map((t) => t.termKey)).toEqual(["low"]);
});

test("a term returns to the queue once its backoff expires", () => {
  seedCandidate("high", 9);
  recordAttempt(db, "high", 10_000);
  const batch = selectPendingBatch(db, 10, {
    nowMs: 12_000,
    retryBaseCooldownMs: 1000,
    minDocFreq: 0,
  });
  expect(batch.map((t) => t.termKey)).toEqual(["high"]);
});

test("backoff grows with repeated failures", () => {
  seedCandidate("high", 9);
  recordAttempt(db, "high", 0);
  recordAttempt(db, "high", 0);
  recordAttempt(db, "high", 0);
  // attempts=3 -> base * 2^2 = 4000 ms
  expect(
    selectPendingBatch(db, 10, { nowMs: 3000, retryBaseCooldownMs: 1000, minDocFreq: 0 }).length,
  ).toBe(0);
  expect(
    selectPendingBatch(db, 10, { nowMs: 5000, retryBaseCooldownMs: 1000, minDocFreq: 0 }).length,
  ).toBe(1);
});

test("selectPendingBatch excludes a term demoted below the floor", () => {
  seedCandidate("cdr"); // docFreq 3, above the floor
  seedCandidate("slo"); // docFreq 3, above the floor
  // Simulate what `reconcilePass` does to a term whose sources vanished:
  // demote to pending and zero out its statistics/score.
  demoteTerm(db, "cdr", 3000);
  applyStats(
    db,
    "cdr",
    { docFreq: 1, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    0,
    3000,
  );

  const batch = selectPendingBatch(db, 10, {
    nowMs: 10_000,
    retryBaseCooldownMs: 1000,
    minDocFreq: 3,
  });
  expect(batch.map((t) => t.termKey)).toEqual(["slo"]);
  expect(getTerm(db, "cdr")?.status).toBe("pending");
});

test("retryCooldownMs caps at 24 hours", () => {
  expect(retryCooldownMs(50, 1000)).toBe(24 * 60 * 60 * 1000);
  expect(retryCooldownMs(0, 1000)).toBe(0);
});

test("selectStaleForRecheck returns consolidated rows oldest-verified first", () => {
  seedCandidate("a");
  seedCandidate("b");
  consolidate("a", 5000);
  consolidate("b", 5000);
  applyStats(
    db,
    "b",
    { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    1,
    9000,
  );
  expect(selectStaleForRecheck(db, 1, 20_000)[0]?.termKey).toBe("a");
});

test("selectStaleForRecheck skips terms verified after the cutoff", () => {
  seedCandidate("a");
  consolidate("a", 5000);
  expect(selectStaleForRecheck(db, 10, 4000).length).toBe(0);
  expect(selectStaleForRecheck(db, 10, 6000).length).toBe(1);
});

test("findBySynonym resolves the canonical term", () => {
  seedCandidate("cdr");
  consolidate("cdr", 2000, ["change data record"]);
  expect(findBySynonym(db, "change data record")?.termKey).toBe("cdr");
  expect(findBySynonym(db, "nope")).toBe(null);
});

test("demoteTerm returns a consolidated row to pending and clears its definition", () => {
  seedCandidate("cdr");
  consolidate("cdr");
  demoteTerm(db, "cdr", 3000);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.definition).toBe(null);
});

test("countByStatus reports totals", () => {
  seedCandidate("a");
  seedCandidate("b");
  consolidate("a");
  markVetoed(db, "b", 2000);
  const c = countByStatus(db);
  expect(c.total).toBe(1);
  expect(c.vetoed).toBe(1);
});

test("listConsolidated is ranked by score", () => {
  seedCandidate("low", 1);
  seedCandidate("high", 9);
  consolidate("low");
  consolidate("high");
  expect(listConsolidated(db, 10)[0]?.termKey).toBe("high");
});

test("pass state defaults to a zero watermark and round-trips", () => {
  expect(readPassState(db).watermarkMs).toBe(0);
  expect(readPassState(db).watermarkId).toBe("");
  writePassState(db, {
    watermarkMs: 42,
    watermarkId: "slack:m1",
    lastPassAt: 99,
    lastPassNew: 2,
    scannedItems: 7,
  });
  expect(readPassState(db).watermarkMs).toBe(42);
  expect(readPassState(db).watermarkId).toBe("slack:m1");
  writePassState(db, {
    watermarkMs: 50,
    watermarkId: "slack:m9",
    lastPassAt: 100,
    lastPassNew: 1,
    scannedItems: 8,
  });
  expect(readPassState(db).watermarkMs).toBe(50);
  expect(readPassState(db).watermarkId).toBe("slack:m9");
});

test("listAllKeys and clearGlossary", () => {
  seedCandidate("a");
  seedCandidate("b");
  expect(listAllKeys(db).sort()).toEqual(["a", "b"]);
  clearGlossary(db);
  expect(listAllKeys(db)).toEqual([]);
  expect(readPassState(db).watermarkMs).toBe(0);
});

describe("selectSnippetUpgradeBatch", () => {
  const OPTS = { nowMs: 1_000_000, retryBaseCooldownMs: 60_000 };

  function seedConsolidated(
    key: string,
    p: { source: "llm" | "snippet"; score: number; attempts?: number; lastAttemptAt?: number },
  ): void {
    dbRun(
      db,
      `INSERT INTO glossary_term
         (term_key, display_term, status, definition, definition_source, doc_freq,
          service_spread, score, form, first_seen_at, last_seen_at, attempts,
          last_attempt_at, updated_at)
       VALUES (?, ?, 'consolidated', 'def', ?, 5, 2, ?, 'acronym', 1, 2, ?, ?, 1)`,
      [key, key.toUpperCase(), p.source, p.score, p.attempts ?? 0, p.lastAttemptAt ?? 0],
    );
  }

  test("selects only consolidated snippet-sourced rows", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10 });
    seedConsolidated("slo", { source: "llm", score: 99 });
    dbRun(
      db,
      `INSERT INTO glossary_term
         (term_key, display_term, status, doc_freq, service_spread, score, form,
          first_seen_at, last_seen_at, updated_at)
       VALUES ('pend', 'PEND', 'pending', 5, 2, 50, 'acronym', 1, 2, 1)`,
      [],
    );
    expect(selectSnippetUpgradeBatch(db, 10, OPTS).map((t) => t.termKey)).toEqual(["cdr"]);
  });

  // Ordering, not count: a count-only assertion passes under either ordering.
  test("rotates round-robin by last_attempt_at ascending", () => {
    seedConsolidated("recent", { source: "snippet", score: 99, lastAttemptAt: 900_000 });
    seedConsolidated("never", { source: "snippet", score: 1, lastAttemptAt: 0 });
    seedConsolidated("middle", { source: "snippet", score: 50, lastAttemptAt: 400_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS).map((t) => t.termKey)).toEqual([
      "never",
      "middle",
      "recent",
    ]);
  });

  test("withholds a term still inside its exponential backoff", () => {
    // attempts=1 -> cooldown 60_000; last attempt at 999_000 -> due at 1_059_000 > now.
    seedConsolidated("cdr", { source: "snippet", score: 10, attempts: 1, lastAttemptAt: 999_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS)).toEqual([]);
  });

  test("admits a term whose backoff has elapsed", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10, attempts: 1, lastAttemptAt: 100_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS).map((t) => t.termKey)).toEqual(["cdr"]);
  });

  // SQLite treats LIMIT -1 as UNLIMITED, so a subtraction-derived caller that
  // goes negative would silently select the whole snippet population.
  test("returns nothing for a zero or negative limit", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10 });
    expect(selectSnippetUpgradeBatch(db, 0, OPTS)).toEqual([]);
    expect(selectSnippetUpgradeBatch(db, -1, OPTS)).toEqual([]);
  });
});

test("markConsolidated stamps last_attempt_at", () => {
  dbRun(
    db,
    `INSERT INTO glossary_term
       (term_key, display_term, status, doc_freq, service_spread, score, form,
        first_seen_at, last_seen_at, updated_at)
     VALUES ('cdr', 'CDR', 'pending', 5, 2, 10, 'acronym', 1, 2, 1)`,
    [],
  );
  markConsolidated(db, {
    termKey: "cdr",
    definition: "d",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs: 777,
  });
  const row = db
    .query("SELECT last_attempt_at FROM glossary_term WHERE term_key = 'cdr'")
    .get() as { last_attempt_at: number };
  expect(row.last_attempt_at).toBe(777);
});
