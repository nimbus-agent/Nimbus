import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { markConsolidated, upsertCandidate } from "../glossary/glossary-store.ts";
import { runGlossary } from "./glossary.ts";

let db: Database;

function seed(key: string, opts: { score?: number; synonyms?: string[] } = {}): void {
  upsertCandidate(db, {
    key,
    surface: key.toUpperCase(),
    form: "acronym",
    stats: { docFreq: 4, serviceSpread: 2, firstSeenAt: 100, lastSeenAt: 900, topSources: [] },
    score: opts.score ?? 1,
    nowMs: 1000,
  });
  markConsolidated(db, {
    termKey: key,
    definition: `definition of ${key}`,
    definitionSource: "llm",
    synonyms: opts.synonyms ?? [],
    nearMisses: [],
    nowMs: 1000,
  });
}

function ctx() {
  return { db, notify: () => undefined, sessionId: "s1" };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("no argument returns a frequency-ranked list", async () => {
  seed("cdr", { score: 9 });
  seed("slo", { score: 2 });
  const brief = await runGlossary({}, ctx());
  expect(brief.mode).toBe("list");
  expect(brief.entries.map((e) => e.term)).toEqual(["CDR", "SLO"]);
});

test("an exact term returns its consolidated definition", async () => {
  seed("cdr");
  const brief = await runGlossary({ term: "CDR" }, ctx());
  expect(brief.mode).toBe("term");
  expect(brief.matchedVia).toBe("exact");
  expect(brief.entries[0]?.definition).toBe("definition of cdr");
});

test("a plural query resolves to the singular key", async () => {
  seed("slo");
  const brief = await runGlossary({ term: "SLOs" }, ctx());
  expect(brief.mode).toBe("term");
});

test("a synonym resolves to the canonical term", async () => {
  seed("cdr", { synonyms: ["Change Data Record"] });
  const brief = await runGlossary({ term: "Change Data Record" }, ctx());
  expect(brief.mode).toBe("term");
  expect(brief.matchedVia).toBe("synonym");
  expect(brief.entries[0]?.term).toBe("CDR");
});

test("an unknown term returns near-miss suggestions rather than nothing", async () => {
  seed("cdr");
  const brief = await runGlossary({ term: "CDC" }, ctx());
  expect(brief.mode).toBe("miss");
  expect(brief.entries).toEqual([]);
  expect(brief.suggestions).toContain("cdr");
});

test("an unknown term with no close match still returns a miss brief", async () => {
  seed("cdr");
  const brief = await runGlossary({ term: "kubernetes" }, ctx());
  expect(brief.mode).toBe("miss");
  expect(brief.suggestions).toEqual([]);
});

test("an empty glossary reports a gap note", async () => {
  const brief = await runGlossary({}, ctx());
  expect(brief.entries).toEqual([]);
  expect(brief.gaps.length).toBeGreaterThan(0);
});

test("pending terms are reported in the stats", async () => {
  upsertCandidate(db, {
    key: "wip",
    surface: "WIP",
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 1,
    nowMs: 1000,
  });
  const brief = await runGlossary({}, ctx());
  expect(brief.stats.pending).toBe(1);
});

test("the limit is honoured", async () => {
  seed("cdr", { score: 9 });
  seed("slo", { score: 5 });
  seed("rpo", { score: 1 });
  const brief = await runGlossary({ limit: 2 }, ctx());
  expect(brief.entries.length).toBe(2);
});

test("the brief carries latency and a version", async () => {
  seed("cdr");
  const brief = await runGlossary({}, ctx());
  expect(brief.kind).toBe("glossary");
  expect(brief.agentVersion).toBe(1);
  expect(brief.latencyMs).toBeGreaterThanOrEqual(0);
});
