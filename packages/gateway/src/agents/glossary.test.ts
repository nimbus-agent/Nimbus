import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { markConsolidated, upsertCandidate, writePassState } from "../glossary/glossary-store.ts";
import { runGlossary } from "./glossary.ts";

let db: Database;

function seed(
  key: string,
  opts: { score?: number; synonyms?: string[]; definitionSource?: "llm" | "snippet" } = {},
): void {
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
    definitionSource: opts.definitionSource ?? "llm",
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

test("a pending (never-consolidated) term is never suggested as a near-miss", async () => {
  seed("cdr");
  upsertCandidate(db, {
    key: "cdc",
    surface: "CDC",
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 1,
    nowMs: 1000,
  });
  const brief = await runGlossary({ term: "cdq" }, ctx());
  expect(brief.mode).toBe("miss");
  expect(brief.suggestions).toContain("cdr");
  expect(brief.suggestions).not.toContain("cdc");
});

test("an empty glossary reports a gap note", async () => {
  const brief = await runGlossary({}, ctx());
  expect(brief.entries).toEqual([]);
  expect(brief.gaps.length).toBeGreaterThan(0);
});

test("a brief returning entries does not carry the empty-index gap note", async () => {
  seed("cdr");
  const brief = await runGlossary({}, ctx());
  expect(brief.entries.length).toBeGreaterThan(0);
  expect(brief.gaps.some((g) => g.detail.includes("index is empty"))).toBe(false);
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

test("reports how many definitions are raw snippets", async () => {
  // Asymmetric on purpose: 2 snippet + 1 llm. A symmetric 1-of-2 split would
  // make "count = 1" ambiguous between the two filters, so flipping the
  // store query's `definition_source` predicate would coincidentally produce
  // the identical "1 of 2" text and the assertion below would still pass —
  // verifying message formatting, not that the count came from the intended
  // filter. With 2-of-3, flipping the filter yields a different count
  // (1-of-3), so this assertion catches that mutation on its own.
  seed("cdr", { definitionSource: "snippet" });
  seed("slo", { definitionSource: "snippet" });
  seed("rpo", { definitionSource: "llm" });
  // A gap note about extraction never having run takes priority over the
  // snippet-ratio note (buildGaps returns early on lastPassAt === null), so a
  // completed pass must be on record for this test to reach that logic.
  writePassState(db, {
    watermarkMs: 900,
    watermarkId: "rpo",
    lastPassAt: 1000,
    lastPassNew: 3,
    scannedItems: 3,
  });
  const brief = await runGlossary({}, ctx());
  const note = brief.gaps.find((g) => g.detail.includes("verbatim snippet"));
  expect(note).toBeDefined();
  expect(note?.detail).toContain("2 of 3");
  expect(note?.remediation).toContain("--refresh");
});

test("omits the snippet note when every definition came from a model", async () => {
  seed("slo", { definitionSource: "llm" });
  writePassState(db, {
    watermarkMs: 900,
    watermarkId: "slo",
    lastPassAt: 1000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  const brief = await runGlossary({}, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("verbatim snippet"))).toBe(false);
});
