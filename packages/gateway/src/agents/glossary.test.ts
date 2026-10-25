import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import {
  computeTermStats,
  markConsolidated,
  upsertCandidate,
  writePassState,
} from "../glossary/glossary-store.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { sourceTypesFor } from "../sources/source-kinds.ts";
import {
  BUILTIN_SOURCE_MAPPING,
  resolveSourceMapping,
  type SourceMapping,
} from "../sources/source-mapping.ts";
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
    stats: {
      docFreq: 4,
      serviceSpread: 2,
      firstSeenAt: 100,
      lastSeenAt: 900,
      topSources: [],
      contributingTypes: [],
    },
    score: opts.score ?? 1,
    nowMs: 1000,
  });
  markConsolidated(db, {
    termKey: key,
    definition: `definition of ${key}`,
    definitionSource: opts.definitionSource ?? "llm",
    definitionLocal: false,
    synonyms: opts.synonyms ?? [],
    nearMisses: [],
    nowMs: 1000,
  });
}

function ctx(mapping: SourceMapping = BUILTIN_SOURCE_MAPPING) {
  return { db, notify: () => undefined, sessionId: "s1", mapping };
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
  const brief = await runGlossary({}, ctx());
  expect(brief.stats.pending).toBe(1);
});

test("the limit is honoured", async () => {
  seed("cdr", { score: 9 });
  seed("slo", { score: 5 });
  seed("rpo", { score: 1 });
  const brief = await runGlossary({ limit: 2 }, ctx());
  expect(brief.entries).toHaveLength(2);
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

describe("reads under an excluding mapping", () => {
  const NO_SLACK = resolveSourceMapping({
    doc: mergeLayerDocs([
      parseLayerDoc(
        { kind: "base", id: "base", path: "/virtual/base.toml" },
        '[sources]\nexclude = ["slack:message"]\n',
      ),
    ]),
  });

  function item(service: string, type: string, id: string, text: string, at: number): void {
    upsertIndexedItem(db, {
      service,
      type,
      externalId: id,
      title: text,
      bodyPreview: text,
      modifiedAt: at,
      syncedAt: at,
    });
  }

  /** A consolidated term whose stored stats are measured over the built-in set, as a pass would. */
  function consolidatedFromIndex(
    key: string,
    score = 5,
    o: {
      definitionSource?: "llm" | "snippet";
      synonyms?: string[];
      nearMisses?: string[];
    } = {},
  ): void {
    upsertCandidate(db, {
      key,
      surface: key.toUpperCase(),
      form: "acronym",
      stats: computeTermStats(db, key, sourceTypesFor("glossary")),
      score,
      nowMs: 1000,
    });
    markConsolidated(db, {
      termKey: key,
      definition: `definition of ${key}`,
      definitionSource: o.definitionSource ?? "llm",
      definitionLocal: false,
      synonyms: o.synonyms ?? [],
      nearMisses: o.nearMisses ?? [],
      nowMs: 1000,
    });
  }

  function passRan(): void {
    writePassState(db, {
      watermarkMs: 900,
      watermarkId: "x",
      lastPassAt: 1000,
      lastPassNew: 1,
      scannedItems: 1,
    });
  }

  function slackOnly(key: string): void {
    for (let i = 0; i < 3; i++) {
      item("slack", "message", `${key}-s${String(i)}`, `the ${key.toUpperCase()} rollout`, 100 + i);
    }
  }

  function jiraOnly(key: string): void {
    item("jira", "issue", `${key}-j`, `the ${key.toUpperCase()} ticket`, 200);
  }

  function row(key: string): unknown {
    return db.query("SELECT * FROM glossary_term WHERE term_key = ?").get(key);
  }

  test("an excluded source's only term is hidden from list, term lookup, near misses and the count", async () => {
    for (let i = 0; i < 3; i++)
      item("slack", "message", `s${String(i)}`, "the CDR rollout", 100 + i);
    item("jira", "issue", "j1", "the WAL ticket", 200);
    consolidatedFromIndex("cdr", 9);
    consolidatedFromIndex("wal", 1);
    const before = row("cdr");

    const list = await runGlossary({}, ctx(NO_SLACK));
    expect(list.entries.map((e) => e.term)).toEqual(["WAL"]);
    expect(list.stats.total).toBe(1);
    const lookup = await runGlossary({ term: "CDR" }, ctx(NO_SLACK));
    expect(lookup.mode).toBe("miss");
    expect(lookup.entries).toEqual([]);
    const near = await runGlossary({ term: "cdq" }, ctx(NO_SLACK));
    expect(near.suggestions).not.toContain("cdr");
    expect(row("cdr")).toEqual(before);

    // Re-included: visible again, the row untouched throughout.
    const again = await runGlossary({}, ctx(BUILTIN_SOURCE_MAPPING));
    expect(again.entries.map((e) => e.term)).toEqual(["CDR", "WAL"]);
    expect(again.stats.total).toBe(2);
    expect((await runGlossary({ term: "CDR" }, ctx())).mode).toBe("term");
    expect((await runGlossary({ term: "cdq" }, ctx())).suggestions).toContain("cdr");
    expect(row("cdr")).toEqual(before);
  });

  test("a term in two services shows effective stats only", async () => {
    for (let i = 0; i < 3; i++)
      item("slack", "message", `s${String(i)}`, "the CDR rollout", 100 + i);
    for (let i = 0; i < 2; i++) item("jira", "issue", `j${String(i)}`, "the CDR ticket", 300 + i);
    consolidatedFromIndex("cdr");
    const before = row("cdr") as { doc_freq: number };
    expect(before.doc_freq).toBe(5);

    const list = await runGlossary({}, ctx(NO_SLACK));
    expect(list.entries[0]?.docFreq).toBe(2);
    expect(list.entries[0]?.serviceSpread).toBe(1);
    expect(list.entries[0]?.topSources.every((s) => s.service === "jira")).toBe(true);
    const term = await runGlossary({ term: "CDR" }, ctx(NO_SLACK));
    expect(term.mode).toBe("term");
    expect(term.entries[0]?.docFreq).toBe(2);
    expect(row("cdr")).toEqual(before);

    // The built-in mapping shows the stored figures.
    expect((await runGlossary({}, ctx())).entries[0]?.docFreq).toBe(5);
  });

  test("the snippet ratio counts visible snippet terms only", async () => {
    slackOnly("cdr");
    slackOnly("lsn");
    jiraOnly("wal");
    jiraOnly("xid");
    consolidatedFromIndex("cdr", 5, { definitionSource: "snippet" });
    consolidatedFromIndex("lsn", 5, { definitionSource: "snippet" });
    consolidatedFromIndex("wal", 5, { definitionSource: "snippet" });
    consolidatedFromIndex("xid", 5, { definitionSource: "llm" });
    passRan();
    const hidden = await runGlossary({}, ctx(NO_SLACK));
    const note = hidden.gaps.find((g) => g.detail.includes("verbatim snippet"));
    expect(note?.detail).toContain("1 of 2");
    const all = await runGlossary({}, ctx());
    expect(all.gaps.find((g) => g.detail.includes("verbatim snippet"))?.detail).toContain("3 of 4");
  });

  test("terms hidden by the mapping get their own gap note, never the min_doc_freq one", async () => {
    slackOnly("cdr");
    slackOnly("lsn");
    consolidatedFromIndex("cdr");
    consolidatedFromIndex("lsn");
    passRan();
    const brief = await runGlossary({}, ctx(NO_SLACK));
    expect(brief.entries).toEqual([]);
    expect(brief.stats.total).toBe(0);
    expect(brief.stats.hidden).toBe(2);
    const note = brief.gaps.find((g) => g.detail.includes("current source mapping"));
    expect(note?.detail).toBe(
      "2 consolidated term(s) are hidden because their sources are not in the current source mapping.",
    );
    expect(note?.remediation).toContain("nimbus config explain sources");
    expect(brief.gaps.some((g) => g.detail.includes("minimum document frequency"))).toBe(false);
    expect(brief.gaps.some((g) => (g.remediation ?? "").includes("min_doc_freq"))).toBe(false);

    // Some visible, some hidden: the mapping note still states the hidden count.
    jiraOnly("wal");
    consolidatedFromIndex("wal");
    const mixed = await runGlossary({}, ctx(NO_SLACK));
    expect(mixed.entries.map((e) => e.term)).toEqual(["WAL"]);
    expect(mixed.gaps.find((g) => g.detail.includes("current source mapping"))?.detail).toMatch(
      /^2 consolidated term\(s\) are hidden/,
    );
    // The built-in mapping hides nothing and says nothing about it.
    const builtin = await runGlossary({}, ctx());
    expect(builtin.stats.hidden).toBe(0);
    expect(builtin.gaps.some((g) => g.detail.includes("current source mapping"))).toBe(false);
  });

  test("stored near misses that name a hidden term are not shown", async () => {
    slackOnly("cdr");
    jiraOnly("cdq");
    consolidatedFromIndex("cdr");
    consolidatedFromIndex("cdq", 5, { nearMisses: ["cdr"] });
    expect((await runGlossary({}, ctx(NO_SLACK))).entries[0]?.nearMisses).toEqual([]);
    expect((await runGlossary({ term: "CDQ" }, ctx(NO_SLACK))).entries[0]?.nearMisses).toEqual([]);
    expect((await runGlossary({ term: "CDQ" }, ctx())).entries[0]?.nearMisses).toEqual(["cdr"]);
  });

  test("a hidden exact match falls through to a visible synonym", async () => {
    slackOnly("cdr");
    jiraOnly("chg");
    consolidatedFromIndex("cdr");
    consolidatedFromIndex("chg", 5, { synonyms: ["CDR"] });
    const brief = await runGlossary({ term: "CDR" }, ctx(NO_SLACK));
    expect(brief.mode).toBe("term");
    expect(brief.matchedVia).toBe("synonym");
    expect(brief.entries[0]?.term).toBe("CHG");
    // The built-in mapping still resolves the exact term.
    expect((await runGlossary({ term: "CDR" }, ctx())).entries[0]?.term).toBe("CDR");
  });

  test("a hidden first synonym match does not hide a visible second one", async () => {
    slackOnly("aaa");
    jiraOnly("bbb");
    consolidatedFromIndex("aaa", 5, { synonyms: ["Shared Name"] });
    consolidatedFromIndex("bbb", 5, { synonyms: ["Shared Name"] });
    const hidden = await runGlossary({ term: "Shared Name" }, ctx(NO_SLACK));
    expect(hidden.entries[0]?.term).toBe("BBB");
    expect((await runGlossary({ term: "Shared Name" }, ctx())).entries[0]?.term).toBe("AAA");
  });
});
