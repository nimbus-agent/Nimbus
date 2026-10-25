import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { type LayerKind, mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { dbRun } from "../db/write.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { sourceTypesFor } from "../sources/source-kinds.ts";
import { BUILTIN_SOURCE_MAPPING, resolveSourceMapping } from "../sources/source-mapping.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { upsertIndexedItem } from "../index/item-store.ts";
import {
  type AgentTermUpsert,
  applyStats,
  clearGlossary,
  computeTermStats,
  countByStatus,
  deleteAgentTerm,
  demoteTerm,
  effectiveView,
  findBySynonym,
  getTerm,
  hasEffectiveOccurrence,
  listAllKeys,
  listConsolidated,
  listVisibleConsolidated,
  markConsolidated,
  markVetoed,
  readPassState,
  recordAttempt,
  retryCooldownMs,
  selectPendingBatch,
  selectSnippetUpgradeBatch,
  selectStaleForRecheck,
  termOwnership,
  upsertAgentTerm,
  upsertCandidate,
  upsertManualTerm,
  writePassState,
} from "./glossary-store.ts";
import type { GlossarySets, GlossaryTerm } from "./glossary-types.ts";
import { glossarySets } from "./glossary-visibility.ts";

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
    stats: {
      docFreq: 3,
      serviceSpread: 1,
      firstSeenAt: 100,
      lastSeenAt: 200,
      topSources: [],
      contributingTypes: [],
    },
    score,
    nowMs: 1000,
  });
}

function consolidate(key: string, nowMs = 2000, synonyms: string[] = []): void {
  markConsolidated(db, {
    termKey: key,
    definition: "d",
    definitionSource: "llm",
    definitionLocal: false,
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
  const s = computeTermStats(db, "cdr", sourceTypesFor("glossary"));
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
  const s = computeTermStats(db, "cdr", sourceTypesFor("glossary"));
  expect(s.docFreq).toBe(1);
  expect(s.serviceSpread).toBe(1);
  expect(s.topSources.map((t) => t.service)).toEqual(["slack"]);
});

test("computeTermStats returns at most five top sources", () => {
  for (let i = 0; i < 8; i++) {
    seedItem({ externalId: `i${String(i)}`, title: "CDR", body: "CDR here", modifiedAt: 100 + i });
  }
  expect(computeTermStats(db, "cdr", sourceTypesFor("glossary")).topSources).toHaveLength(5);
});

test("computeTermStats is zero for an absent term", () => {
  expect(computeTermStats(db, "nosuchterm", sourceTypesFor("glossary")).docFreq).toBe(0);
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
  expect(computeTermStats(db, "cdr", sourceTypesFor("glossary")).docFreq).toBe(0);
});

test("computeTermStats drops to zero after the citing item is deleted", () => {
  seedItem({ externalId: "a", title: "CDR", body: "CDR", modifiedAt: 100 });
  expect(computeTermStats(db, "cdr", sourceTypesFor("glossary")).docFreq).toBe(1);
  db.run("DELETE FROM item");
  expect(computeTermStats(db, "cdr", sourceTypesFor("glossary")).docFreq).toBe(0);
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
  expect(computeTermStats(db, "write-behind", sourceTypesFor("glossary")).docFreq).toBe(2);
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
  expect(computeTermStats(db, "write-behind", sourceTypesFor("glossary")).docFreq).toBe(2);
});

test("an underscored term is matched", () => {
  seedItem({ externalId: "u1", title: "keys", body: "set the shard_key first", modifiedAt: 100 });
  expect(computeTermStats(db, "shard_key", sourceTypesFor("glossary")).docFreq).toBe(1);
});

test("a term key with FTS-hostile characters degrades to zero, never throws", () => {
  expect(() => computeTermStats(db, 'we"ird^(term)', sourceTypesFor("glossary"))).not.toThrow();
});

const QUEUE = { nowMs: 10_000, retryBaseCooldownMs: 1000, minDocFreq: 0 };

/** The built-in mapping: every known type is effective, so the queues take the fast path. */
const BUILTIN_SETS: GlossarySets = {
  effective: sourceTypesFor("glossary"),
  known: sourceTypesFor("glossary"),
  fast: true,
};

test("markVetoed is sticky and keeps the row out of the pending batch", () => {
  seedCandidate("cdr");
  markVetoed(db, "cdr", 2000);
  expect(getTerm(db, "cdr")?.status).toBe("vetoed");
  expect(selectPendingBatch(db, 10, QUEUE, BUILTIN_SETS)).toHaveLength(0);
});

test("selectPendingBatch orders by score descending and honours the limit", () => {
  seedCandidate("low", 1);
  seedCandidate("high", 9);
  seedCandidate("mid", 5);
  expect(selectPendingBatch(db, 2, QUEUE, BUILTIN_SETS).map((t) => t.termKey)).toEqual([
    "high",
    "mid",
  ]);
});

test("a freshly-attempted term is withheld while its backoff is active", () => {
  seedCandidate("high", 9);
  seedCandidate("low", 1);
  recordAttempt(db, "high", 10_000);
  const batch = selectPendingBatch(
    db,
    10,
    {
      nowMs: 10_500,
      retryBaseCooldownMs: 1000,
      minDocFreq: 0,
    },
    BUILTIN_SETS,
  );
  expect(batch.map((t) => t.termKey)).toEqual(["low"]);
});

test("a term returns to the queue once its backoff expires", () => {
  seedCandidate("high", 9);
  recordAttempt(db, "high", 10_000);
  const batch = selectPendingBatch(
    db,
    10,
    {
      nowMs: 12_000,
      retryBaseCooldownMs: 1000,
      minDocFreq: 0,
    },
    BUILTIN_SETS,
  );
  expect(batch.map((t) => t.termKey)).toEqual(["high"]);
});

test("backoff grows with repeated failures", () => {
  seedCandidate("high", 9);
  recordAttempt(db, "high", 0);
  recordAttempt(db, "high", 0);
  recordAttempt(db, "high", 0);
  // attempts=3 -> base * 2^2 = 4000 ms
  expect(
    selectPendingBatch(
      db,
      10,
      { nowMs: 3000, retryBaseCooldownMs: 1000, minDocFreq: 0 },
      BUILTIN_SETS,
    ),
  ).toHaveLength(0);
  expect(
    selectPendingBatch(
      db,
      10,
      { nowMs: 5000, retryBaseCooldownMs: 1000, minDocFreq: 0 },
      BUILTIN_SETS,
    ),
  ).toHaveLength(1);
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
    {
      docFreq: 1,
      serviceSpread: 1,
      firstSeenAt: 1,
      lastSeenAt: 2,
      topSources: [],
      contributingTypes: [],
    },
    0,
    3000,
  );

  const batch = selectPendingBatch(
    db,
    10,
    {
      nowMs: 10_000,
      retryBaseCooldownMs: 1000,
      minDocFreq: 3,
    },
    BUILTIN_SETS,
  );
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
    {
      docFreq: 3,
      serviceSpread: 1,
      firstSeenAt: 1,
      lastSeenAt: 2,
      topSources: [],
      contributingTypes: [],
    },
    1,
    9000,
  );
  expect(selectStaleForRecheck(db, 1, 20_000)[0]?.termKey).toBe("a");
});

test("selectStaleForRecheck skips terms verified after the cutoff", () => {
  seedCandidate("a");
  consolidate("a", 5000);
  expect(selectStaleForRecheck(db, 10, 4000)).toHaveLength(0);
  expect(selectStaleForRecheck(db, 10, 6000)).toHaveLength(1);
});

test("findBySynonym resolves the canonical term", () => {
  seedCandidate("cdr");
  consolidate("cdr", 2000, ["change data record"]);
  expect(findBySynonym(db, "change data record")?.termKey).toBe("cdr");
  expect(findBySynonym(db, "nope")).toBeNull();
});

test("demoteTerm returns a consolidated row to pending and clears its definition", () => {
  seedCandidate("cdr");
  consolidate("cdr");
  demoteTerm(db, "cdr", 3000);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.definition).toBeNull();
});

test("countByStatus reports totals", () => {
  seedCandidate("a");
  seedCandidate("b");
  consolidate("a");
  markVetoed(db, "b", 2000);
  const c = countByStatus(db, glossarySets(db, BUILTIN_SOURCE_MAPPING));
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

describe("agent terms (capture sink)", () => {
  const agent = (captureId: string, definition = "agent def"): AgentTermUpsert => ({
    termKey: "wal",
    displayTerm: "WAL",
    definition,
    synonyms: ["write-ahead log"],
    captureId,
    stats: computeTermStats(db, "wal", sourceTypesFor("glossary")),
    score: 0,
    nowMs: 10,
  });

  test("upsertAgentTerm inserts a consolidated 'agent' row owned by the capture", () => {
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(termOwnership(db, "wal")).toEqual({
      status: "consolidated",
      definitionSource: "agent",
      captureId: "cap_1",
    });
    expect(getTerm(db, "wal")?.definition).toBe("agent def");
  });

  test("a mentioned term keeps its evidence window", () => {
    seedItem({ externalId: "w1", title: "t", body: "the wal is flushed", modifiedAt: 500 });
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(getTerm(db, "wal")?.firstSeenAt).toBe(500);
    expect(getTerm(db, "wal")?.docFreq).toBe(1);
  });

  test("an unmentioned term is stamped with nowMs for first/last seen", () => {
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(getTerm(db, "wal")?.firstSeenAt).toBe(10);
    expect(getTerm(db, "wal")?.lastSeenAt).toBe(10);
  });

  test("takes over an llm/snippet row, and an earlier agent row (ownership moves)", () => {
    seedCandidate("wal", 1);
    consolidate("wal", 5, []);
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(upsertAgentTerm(db, agent("cap_2", "newer"))).toBe(true);
    expect(termOwnership(db, "wal")?.captureId).toBe("cap_2");
    expect(getTerm(db, "wal")?.definition).toBe("newer");
  });

  test("takes over a model-vetoed row: the owner's explicit accept outranks the classifier", () => {
    seedCandidate("wal", 1);
    markVetoed(db, "wal", 3);
    expect(termOwnership(db, "wal")?.status).toBe("vetoed"); // positive control
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(termOwnership(db, "wal")).toEqual({
      status: "consolidated",
      definitionSource: "agent",
      captureId: "cap_1",
    });
  });

  test("never takes over a manual row", () => {
    seedCandidate("wal", 1);
    upsertManualTerm(db, {
      termKey: "wal",
      displayTerm: "WAL",
      definition: "mine",
      synonyms: [],
      nearMisses: [],
      stats: computeTermStats(db, "wal", sourceTypesFor("glossary")),
      score: 0,
      nowMs: 4,
    });
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(false);
    expect(getTerm(db, "wal")?.definition).toBe("mine");
  });

  test("termOwnership is null for an unknown key", () => {
    expect(termOwnership(db, "nope")).toBeNull();
  });

  test("deleteAgentTerm deletes only while the capture owns the row", () => {
    upsertAgentTerm(db, agent("cap_1"));
    upsertAgentTerm(db, agent("cap_2"));
    expect(deleteAgentTerm(db, "wal", "cap_1")).toBe(false);
    expect(deleteAgentTerm(db, "wal", "cap_2")).toBe(true);
    expect(getTerm(db, "wal")).toBeNull();
  });

  test("a mined sighting refreshes stats but keeps the agent display_term and definition", () => {
    upsertAgentTerm(db, agent("cap_1"));
    upsertCandidate(db, {
      key: "wal",
      surface: "Wal",
      form: "acronym",
      stats: {
        docFreq: 9,
        serviceSpread: 1,
        firstSeenAt: 1,
        lastSeenAt: 2,
        topSources: [],
        contributingTypes: [],
      },
      score: 9,
      nowMs: 11,
    });
    const t = getTerm(db, "wal");
    expect(t?.displayTerm).toBe("WAL");
    expect(t?.definitionSource).toBe("agent");
    expect(t?.definition).toBe("agent def");
    expect(t?.docFreq).toBe(9);
  });

  test("markConsolidated / markVetoed / demoteTerm leave an agent row untouched", () => {
    upsertAgentTerm(db, agent("cap_1"));
    markConsolidated(db, {
      termKey: "wal",
      definition: "llm",
      definitionSource: "llm",
      definitionLocal: false,
      synonyms: [],
      nearMisses: [],
      nowMs: 20,
    });
    markVetoed(db, "wal", 21);
    demoteTerm(db, "wal", 22);
    expect(termOwnership(db, "wal")).toEqual({
      status: "consolidated",
      definitionSource: "agent",
      captureId: "cap_1",
    });
    expect(getTerm(db, "wal")?.definition).toBe("agent def");
  });

  test("clearGlossary (--rebuild) keeps agent rows but still resets the watermark", () => {
    upsertAgentTerm(db, agent("cap_1"));
    seedCandidate("other", 1);
    writePassState(db, {
      watermarkMs: 50,
      watermarkId: "x",
      lastPassAt: 1,
      lastPassNew: 0,
      scannedItems: 1,
    });
    clearGlossary(db);
    expect(listAllKeys(db)).toEqual(["wal"]);
    expect(readPassState(db).watermarkMs).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM glossary_pass_state").get()).toEqual({ n: 0 });
  });
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
    // A pending row with definition_source already set to 'snippet' — e.g. a
    // demoted-then-not-yet-reconsolidated term. Without the `status =
    // 'consolidated'` half of the WHERE clause, this row alone would prove
    // nothing wrong: it is the only fixture row that makes that half
    // load-bearing (dropping it, `slo` is still excluded by its 'llm' source
    // and `pend` by its NULL source).
    dbRun(
      db,
      `INSERT INTO glossary_term
         (term_key, display_term, status, definition_source, doc_freq, service_spread,
          score, form, first_seen_at, last_seen_at, updated_at)
       VALUES ('pend_snip', 'PEND_SNIP', 'pending', 'snippet', 5, 2, 75, 'acronym', 1, 2, 1)`,
      [],
    );
    expect(selectSnippetUpgradeBatch(db, 10, OPTS, BUILTIN_SETS).map((t) => t.termKey)).toEqual([
      "cdr",
    ]);
  });

  // Ordering, not count: a count-only assertion passes under either ordering.
  test("rotates round-robin by last_attempt_at ascending", () => {
    seedConsolidated("recent", { source: "snippet", score: 99, lastAttemptAt: 900_000 });
    seedConsolidated("never", { source: "snippet", score: 1, lastAttemptAt: 0 });
    seedConsolidated("middle", { source: "snippet", score: 50, lastAttemptAt: 400_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS, BUILTIN_SETS).map((t) => t.termKey)).toEqual([
      "never",
      "middle",
      "recent",
    ]);
  });

  test("withholds a term still inside its exponential backoff", () => {
    // attempts=1 -> cooldown 60_000; last attempt at 999_000 -> due at 1_059_000 > now.
    seedConsolidated("cdr", { source: "snippet", score: 10, attempts: 1, lastAttemptAt: 999_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS, BUILTIN_SETS)).toEqual([]);
  });

  test("admits a term whose backoff has elapsed", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10, attempts: 1, lastAttemptAt: 100_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS, BUILTIN_SETS).map((t) => t.termKey)).toEqual([
      "cdr",
    ]);
  });

  // SQLite treats LIMIT -1 as UNLIMITED, so a subtraction-derived caller that
  // goes negative would silently select the whole snippet population.
  test("returns nothing for a zero or negative limit", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10 });
    expect(selectSnippetUpgradeBatch(db, 0, OPTS, BUILTIN_SETS)).toEqual([]);
    expect(selectSnippetUpgradeBatch(db, -1, OPTS, BUILTIN_SETS)).toEqual([]);
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
    definitionLocal: false,
    synonyms: [],
    nearMisses: [],
    nowMs: 777,
  });
  const row = db
    .query("SELECT last_attempt_at FROM glossary_term WHERE term_key = 'cdr'")
    .get() as { last_attempt_at: number };
  expect(row.last_attempt_at).toBe(777);
});

test("a mined sighting refreshes a manual row's stats but not its display form", () => {
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: {
      docFreq: 0,
      serviceSpread: 0,
      firstSeenAt: 0,
      lastSeenAt: 0,
      topSources: [],
      contributingTypes: [],
    },
    score: 0,
    nowMs: 1000,
  });

  upsertCandidate(db, {
    key: "cdr",
    surface: "cdr",
    form: "acronym",
    stats: {
      docFreq: 7,
      serviceSpread: 2,
      firstSeenAt: 10,
      lastSeenAt: 20,
      topSources: [],
      contributingTypes: [],
    },
    score: 9,
    nowMs: 2000,
  });

  const t = getTerm(db, "cdr");
  // Order is load-bearing: `bun:test` halts a test body at its first failing
  // assertion. `docFreq` MUST run and pass before `displayTerm` is checked —
  // otherwise, when the CASE guard regresses to the unconditional clobber,
  // this test would fail on `displayTerm` without ever proving `docFreq`
  // still refreshed, and the red-prove separation of the two ANDed
  // behaviours (statistics DO refresh; display form does NOT change) would
  // not be reproducible from a straight test run. Do not reorder this back.
  expect(t?.docFreq).toBe(7); // statistics DO refresh
  expect(t?.displayTerm).toBe("CDR"); // authored form survives
  expect(t?.definition).toBe("Authored.");
  expect(t?.status).toBe("consolidated");
});

test("a mined sighting still updates a mined row's display form", () => {
  // The other direction of the same CASE expression. A test for either alone
  // passes against the wrong implementation of the other.
  upsertCandidate(db, {
    key: "widget",
    surface: "widget",
    form: "phrase",
    stats: {
      docFreq: 3,
      serviceSpread: 1,
      firstSeenAt: 1,
      lastSeenAt: 2,
      topSources: [],
      contributingTypes: [],
    },
    score: 1,
    nowMs: 1000,
  });
  upsertCandidate(db, {
    key: "widget",
    surface: "Widget",
    form: "phrase",
    stats: {
      docFreq: 4,
      serviceSpread: 1,
      firstSeenAt: 1,
      lastSeenAt: 2,
      topSources: [],
      contributingTypes: [],
    },
    score: 2,
    nowMs: 2000,
  });
  expect(getTerm(db, "widget")?.displayTerm).toBe("Widget");
});

test("a manual row is selected by neither consolidation batch", () => {
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: {
      docFreq: 9,
      serviceSpread: 3,
      firstSeenAt: 1,
      lastSeenAt: 2,
      topSources: [],
      contributingTypes: [],
    },
    score: 99,
    nowMs: 1000,
  });

  // High score, zero attempts, well above the floor — it qualifies on every
  // predicate except the ones that structurally exclude it.
  const pending = selectPendingBatch(
    db,
    10,
    {
      nowMs: 9_000_000,
      retryBaseCooldownMs: 1,
      minDocFreq: 3,
    },
    BUILTIN_SETS,
  );
  const upgrades = selectSnippetUpgradeBatch(
    db,
    10,
    {
      nowMs: 9_000_000,
      retryBaseCooldownMs: 1,
    },
    BUILTIN_SETS,
  );

  expect(pending.map((t) => t.termKey)).not.toContain("cdr");
  expect(upgrades.map((t) => t.termKey)).not.toContain("cdr");
});

test("listConsolidated puts authored terms ahead of higher-scoring mined ones", () => {
  upsertCandidate(db, {
    key: "widget",
    surface: "Widget",
    form: "phrase",
    stats: {
      docFreq: 50,
      serviceSpread: 5,
      firstSeenAt: 1,
      lastSeenAt: 2,
      topSources: [],
      contributingTypes: [],
    },
    score: 999,
    nowMs: 1,
  });
  markConsolidated(db, {
    termKey: "widget",
    definition: "mined",
    definitionSource: "llm",
    definitionLocal: false,
    synonyms: [],
    nearMisses: [],
    nowMs: 1,
  });
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "authored",
    synonyms: [],
    nearMisses: [],
    stats: {
      docFreq: 0,
      serviceSpread: 0,
      firstSeenAt: 0,
      lastSeenAt: 0,
      topSources: [],
      contributingTypes: [],
    },
    score: 0,
    nowMs: 1,
  });

  // Ordered, so assert the ORDER — a count would pass against ORDER BY score
  // alone, which is exactly the bug this guards.
  expect(listConsolidated(db, 10).map((t) => t.termKey)).toEqual(["cdr", "widget"]);
});

test("countByStatus reports manual as a subset of total", () => {
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "authored",
    synonyms: [],
    nearMisses: [],
    stats: {
      docFreq: 0,
      serviceSpread: 0,
      firstSeenAt: 0,
      lastSeenAt: 0,
      topSources: [],
      contributingTypes: [],
    },
    score: 0,
    nowMs: 1,
  });
  const counts = countByStatus(db, glossarySets(db, BUILTIN_SOURCE_MAPPING));
  expect(counts.total).toBe(1);
  expect(counts.manual).toBe(1);
});

// The fixture above (one manual row only) cannot distinguish "manual is a
// SUBSET of total" from "manual is a disjoint fourth bucket that happens to
// equal total" — both readings yield total===1 && manual===1 here. This
// fixture adds a second, MINED consolidated row: a subset reading must count
// it in `total` (2) but exclude it from `manual` (still 1); a disjoint-bucket
// reading that only tallies rows sourced from config would also get this
// right, so what this really pins is that `total` is NOT accidentally scoped
// to `definition_source = 'manual'` — i.e. that `total` still means "every
// consolidated row," authored or mined alike.
test("countByStatus.total includes both a manual and a mined consolidated row", () => {
  seedCandidate("widget");
  consolidate("widget");
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "authored",
    synonyms: [],
    nearMisses: [],
    stats: {
      docFreq: 0,
      serviceSpread: 0,
      firstSeenAt: 0,
      lastSeenAt: 0,
      topSources: [],
      contributingTypes: [],
    },
    score: 0,
    nowMs: 1,
  });
  const counts = countByStatus(db, glossarySets(db, BUILTIN_SOURCE_MAPPING));
  expect(counts.total).toBe(2);
  expect(counts.manual).toBe(1);
});

test("computeTermStats with an empty source set is zero and never builds IN ()", () => {
  seedItem({ externalId: "a", title: "CDR rollout", body: "the CDR is live", modifiedAt: 100 });
  const s = computeTermStats(db, "cdr", []);
  expect(s.docFreq).toBe(0);
  expect(s.contributingTypes).toEqual([]);
});

test("computeTermStats lists the contributing service:type keys, sorted", () => {
  seedItem({ externalId: "a", title: "CDR rollout", body: "the CDR is live", modifiedAt: 100 });
  seedItem({
    externalId: "c",
    service: "jira",
    type: "issue",
    title: "CDR ticket",
    body: "CDR work",
    modifiedAt: 200,
  });
  const s = computeTermStats(db, "cdr", sourceTypesFor("glossary"));
  expect(s.contributingTypes).toEqual(["jira:issue", "slack:message"]);
});

// ---------------------------------------------------------------------------
// Effective-mapping visibility of the model queues (role packs P2, spec § 7)
// ---------------------------------------------------------------------------

describe("queues under an excluding mapping", () => {
  const mappingOf = (kind: LayerKind, body: string) =>
    resolveSourceMapping({
      doc: mergeLayerDocs([
        parseLayerDoc(
          { kind, id: kind, path: `/virtual/${kind}.toml` },
          `[sources]
${body}
`,
        ),
      ]),
    });
  const NO_SLACK = mappingOf("base", 'exclude = ["slack:message"]');

  function seedBacked(key: string, service: string, type: string, score: number): void {
    for (let i = 0; i < 3; i++) {
      seedItem({
        externalId: `${key}-${String(i)}`,
        service,
        type,
        title: `about ${key.toUpperCase()}`,
        body: `the ${key.toUpperCase()} thing`,
        modifiedAt: 100 + i,
      });
    }
    seedCandidate(key, score);
  }

  /** Counts FTS queries issued through `db.query` while `run` executes. */
  function ftsQueriesDuring(run: () => void): number {
    const original = db.query.bind(db);
    let n = 0;
    const spy = (sql: string) => {
      if (sql.includes("item_fts")) n++;
      return original(sql);
    };
    (db as unknown as { query: typeof spy }).query = spy;
    try {
      run();
    } finally {
      (db as unknown as { query: typeof original }).query = original;
    }
    return n;
  }

  test("exclude keeps a Slack-only pending term out of the model batch", () => {
    seedBacked("cdr", "slack", "message", 9);
    seedBacked("wal", "jira", "issue", 1);
    const sets = glossarySets(db, NO_SLACK);
    expect(sets.fast).toBe(false);

    expect(selectPendingBatch(db, 10, QUEUE, sets).map((t) => t.termKey)).toEqual(["wal"]);
    const kept = db
      .query("SELECT status, attempts FROM glossary_term WHERE term_key = 'cdr'")
      .get() as { status: string; attempts: number };
    expect(kept).toEqual({ status: "pending", attempts: 0 });
    // The built-in mapping still selects it.
    expect(
      selectPendingBatch(db, 10, QUEUE, glossarySets(db, BUILTIN_SOURCE_MAPPING)).map(
        (t) => t.termKey,
      ),
    ).toEqual(["cdr", "wal"]);
  });

  test("an excluded snippet term is skipped by the upgrade queue, not the manual one", () => {
    seedBacked("cdr", "slack", "message", 9);
    dbRun(
      db,
      "UPDATE glossary_term SET status = 'consolidated', definition = 'd', definition_source = 'snippet' WHERE term_key = 'cdr'",
      [],
    );
    seedBacked("lsn", "slack", "message", 5);
    dbRun(db, "UPDATE glossary_term SET definition_source = 'manual' WHERE term_key = 'lsn'", []);
    const sets = glossarySets(db, NO_SLACK);
    const opts = { nowMs: 10_000, retryBaseCooldownMs: 1000 };
    expect(selectSnippetUpgradeBatch(db, 10, opts, sets)).toEqual([]);
    expect(selectPendingBatch(db, 10, QUEUE, sets).map((t) => t.termKey)).toEqual(["lsn"]);
  });

  test("the slow path still fills the limit past hidden rows", () => {
    seedBacked("aaa", "slack", "message", 9);
    seedBacked("bbb", "slack", "message", 8);
    seedBacked("ccc", "jira", "issue", 2);
    seedBacked("ddd", "jira", "issue", 1);
    const sets = glossarySets(db, NO_SLACK);
    expect(selectPendingBatch(db, 2, QUEUE, sets).map((t) => t.termKey)).toEqual(["ccc", "ddd"]);
  });

  // More hidden rows than one over-fetch window (limit × 4) ranked ahead of the only visible one:
  // a fixed window would return nothing for as long as the exclusion lasts, since a hidden row is
  // never attempted and so never moves in the queue's order.
  test("the pending queue pages past more hidden rows than one window", () => {
    for (let i = 0; i < 6; i++) seedBacked(`hid${String(i)}`, "slack", "message", 50 - i);
    seedBacked("vis", "jira", "issue", 1);
    const sets = glossarySets(db, NO_SLACK);
    expect(selectPendingBatch(db, 1, QUEUE, sets).map((t) => t.termKey)).toEqual(["vis"]);
    const untouched = db
      .query("SELECT COUNT(*) AS n FROM glossary_term WHERE status = 'pending' AND attempts = 0")
      .get() as { n: number };
    expect(untouched.n).toBe(7);
  });

  test("the snippet upgrade queue pages past more hidden rows than one window", () => {
    for (let i = 0; i < 6; i++) seedBacked(`hid${String(i)}`, "slack", "message", 50 - i);
    seedBacked("vis", "jira", "issue", 1);
    dbRun(
      db,
      "UPDATE glossary_term SET status = 'consolidated', definition = 'd', definition_source = 'snippet', last_attempt_at = CASE WHEN term_key = 'vis' THEN 500 ELSE 0 END",
      [],
    );
    const sets = glossarySets(db, NO_SLACK);
    const opts = { nowMs: 10_000, retryBaseCooldownMs: 1000 };
    expect(selectSnippetUpgradeBatch(db, 1, opts, sets).map((t) => t.termKey)).toEqual(["vis"]);
  });

  test("fast path issues no FTS existence check", () => {
    seedBacked("cdr", "slack", "message", 9);
    const fast = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(fast.fast).toBe(true);
    expect(
      ftsQueriesDuring(() => {
        selectPendingBatch(db, 10, QUEUE, fast);
        selectSnippetUpgradeBatch(db, 10, { nowMs: 10_000, retryBaseCooldownMs: 1000 }, fast);
      }),
    ).toBe(0);
    // Positive control: the same spy does see the slow path's check.
    expect(
      ftsQueriesDuring(() => {
        selectPendingBatch(db, 10, QUEUE, glossarySets(db, NO_SLACK));
      }),
    ).toBeGreaterThan(0);
  });

  test("hasEffectiveOccurrence matches only the effective set", () => {
    seedBacked("cdr", "slack", "message", 9);
    expect(hasEffectiveOccurrence(db, "cdr", ["slack:message"])).toBe(true);
    expect(hasEffectiveOccurrence(db, "cdr", ["jira:issue"])).toBe(false);
    expect(hasEffectiveOccurrence(db, "cdr", [])).toBe(false);
    expect(hasEffectiveOccurrence(db, 'we"ird^(term)', ["slack:message"])).toBe(false);
  });
});

describe("consolidated reads under an excluding mapping", () => {
  const NO_SLACK = resolveSourceMapping({
    doc: mergeLayerDocs([
      parseLayerDoc(
        { kind: "base", id: "base", path: "/virtual/base.toml" },
        '[sources]\nexclude = ["slack:message"]\n',
      ),
    ]),
  });

  /** A consolidated mined term with `n` occurrences in `service:type`, stored stats fixed. */
  function seedConsolidatedIn(
    key: string,
    service: string,
    type: string,
    score: number,
    n = 1,
  ): void {
    for (let i = 0; i < n; i++) {
      seedItem({
        externalId: `${key}-${service}-${String(i)}`,
        service,
        type,
        title: `about ${key.toUpperCase()}`,
        body: `the ${key.toUpperCase()} thing`,
        modifiedAt: 100 + i,
      });
    }
    seedCandidate(key, score);
    consolidate(key);
  }

  function storedRow(key: string): unknown {
    return db.query("SELECT * FROM glossary_term WHERE term_key = ?").get(key);
  }

  test("listConsolidated breaks score ties by term_key", () => {
    seedConsolidatedIn("zzz", "jira", "issue", 5);
    seedConsolidatedIn("aaa", "jira", "issue", 5);
    seedConsolidatedIn("mmm", "jira", "issue", 5);
    expect(listConsolidated(db, 10).map((t) => t.termKey)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("paging with tied scores returns each visible term once", () => {
    for (let i = 0; i < 120; i++) {
      const key = `t${String(i).padStart(3, "0")}x`;
      if (i % 3 === 0) seedConsolidatedIn(key, "slack", "message", 7);
      else seedConsolidatedIn(key, "jira", "issue", 7);
    }
    const sets = glossarySets(db, NO_SLACK);
    expect(sets.fast).toBe(false);
    const keys = listVisibleConsolidated(db, 60, sets, { recomputeStats: false }).map(
      (t) => t.termKey,
    );
    expect(keys).toHaveLength(60);
    expect(new Set(keys).size).toBe(60);
    for (const k of keys) expect(Number(k.slice(1, 4)) % 3).not.toBe(0);
  });

  test("limit counts visible terms", () => {
    seedConsolidatedIn("hid", "slack", "message", 90);
    seedConsolidatedIn("hie", "slack", "message", 80);
    seedConsolidatedIn("hif", "slack", "message", 70);
    seedConsolidatedIn("vis", "jira", "issue", 2);
    seedConsolidatedIn("vit", "jira", "issue", 1);
    const sets = glossarySets(db, NO_SLACK);
    expect(
      listVisibleConsolidated(db, 2, sets, { recomputeStats: false }).map((t) => t.termKey),
    ).toEqual(["vis", "vit"]);
  });

  test("the fast path is listConsolidated unchanged", () => {
    seedConsolidatedIn("cdr", "slack", "message", 5);
    const sets = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(listVisibleConsolidated(db, 10, sets, { recomputeStats: true })).toEqual(
      listConsolidated(db, 10),
    );
  });

  test("manual and agent terms are never hidden", () => {
    seedConsolidatedIn("cdr", "slack", "message", 5);
    seedItem({ externalId: "m", title: "the LSN", body: "LSN", modifiedAt: 100 });
    seedItem({ externalId: "a", title: "the WAL", body: "WAL", modifiedAt: 100 });
    upsertManualTerm(db, {
      termKey: "lsn",
      displayTerm: "LSN",
      definition: "authored",
      synonyms: [],
      nearMisses: [],
      stats: computeTermStats(db, "lsn", sourceTypesFor("glossary")),
      score: 1,
      nowMs: 1000,
    });
    upsertAgentTerm(db, {
      termKey: "wal",
      displayTerm: "WAL",
      definition: "accepted",
      synonyms: [],
      captureId: "cap1",
      stats: computeTermStats(db, "wal", sourceTypesFor("glossary")),
      score: 1,
      nowMs: 1000,
    });
    const sets = glossarySets(db, NO_SLACK);
    expect(
      listVisibleConsolidated(db, 10, sets, { recomputeStats: true })
        .map((t) => t.termKey)
        .sort(),
    ).toEqual(["lsn", "wal"]);
    expect(countByStatus(db, sets).total).toBe(2);
  });

  test("recomputeStats shows effective stats only and never writes them", () => {
    seedConsolidatedIn("cdr", "slack", "message", 5, 3);
    for (let i = 0; i < 2; i++) {
      seedItem({
        externalId: `cdr-jira-${String(i)}`,
        service: "jira",
        type: "issue",
        title: "the CDR ticket",
        body: "CDR",
        modifiedAt: 500 + i,
      });
    }
    applyStats(db, "cdr", computeTermStats(db, "cdr", sourceTypesFor("glossary")), 5, 3000);
    const before = storedRow("cdr");
    expect((before as { doc_freq: number }).doc_freq).toBe(5);
    const sets = glossarySets(db, NO_SLACK);
    const [shown] = listVisibleConsolidated(db, 10, sets, { recomputeStats: true });
    expect(shown?.docFreq).toBe(2);
    expect(shown?.serviceSpread).toBe(1);
    expect(shown?.topSources.every((s) => s.service === "jira")).toBe(true);
    const viewed = effectiveView(db, getTerm(db, "cdr") as GlossaryTerm, sets);
    expect(viewed.docFreq).toBe(2);
    expect(storedRow("cdr")).toEqual(before);
    // Without recompute, the stored figures pass through.
    expect(listVisibleConsolidated(db, 10, sets, { recomputeStats: false })[0]?.docFreq).toBe(5);
    // Identity on the fast path.
    const fast = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(effectiveView(db, getTerm(db, "cdr") as GlossaryTerm, fast).docFreq).toBe(5);
  });

  test("countByStatus counts visible consolidated terms; pending and vetoed stay whole-table", () => {
    seedConsolidatedIn("cdr", "slack", "message", 5);
    seedConsolidatedIn("wal", "jira", "issue", 5);
    seedItem({ externalId: "p", title: "the LSN", body: "LSN", modifiedAt: 100 });
    seedCandidate("lsn"); // pending, Slack-only
    seedCandidate("xid");
    markVetoed(db, "xid", 3000);
    const slow = countByStatus(db, glossarySets(db, NO_SLACK));
    expect(slow).toMatchObject({ total: 1, pending: 1, vetoed: 1 });
    const fast = countByStatus(db, glossarySets(db, BUILTIN_SOURCE_MAPPING));
    expect(fast).toMatchObject({ total: 2, pending: 1, vetoed: 1 });
  });

  test("countByStatus's fast path issues no FTS query", () => {
    seedConsolidatedIn("cdr", "slack", "message", 5);
    const fast = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    const slow = glossarySets(db, NO_SLACK);
    const original = db.query.bind(db);
    let n = 0;
    const spy = (sql: string) => {
      if (sql.includes("item_fts")) n++;
      return original(sql);
    };
    (db as unknown as { query: typeof spy }).query = spy;
    try {
      countByStatus(db, fast);
      expect(n).toBe(0);
      countByStatus(db, slow);
      expect(n).toBeGreaterThan(0); // positive control
    } finally {
      (db as unknown as { query: typeof original }).query = original;
    }
  });

  test("countByStatus over 500 consolidated terms with one type excluded stays under 2 s", () => {
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const key = `k${String(i).padStart(3, "0")}q`;
        if (i % 2 === 0) seedConsolidatedIn(key, "slack", "message", 3);
        else seedConsolidatedIn(key, "jira", "issue", 3);
      }
    })();
    const sets = glossarySets(db, NO_SLACK);
    const start = performance.now();
    const counts = countByStatus(db, sets);
    const elapsed = performance.now() - start;
    console.log(`countByStatus over 500 terms (slow path): ${elapsed.toFixed(1)} ms`);
    expect(counts.total).toBe(250);
    expect(elapsed).toBeLessThan(2000);
  });
});
