/**
 * The shape guards of the three gateway-local extractors (glossary, decisions, ownership) that
 * `fleet-digest-extractors.test.ts` exercises only on well-formed briefs, plus a ghost rank outside
 * the SDK vocabulary. Every malformed brief must come back NOT summarizable (`undefined`) — the
 * digest then discloses it rather than diffing garbage — and each table starts from a control that
 * proves the well-formed brief DOES summarize, so an `undefined` is the guard firing, not a typo.
 */
import { describe, expect, test } from "bun:test";
import { summarizeBrief } from "./fleet-digest-extractors.ts";

const base = { agentVersion: 1, generatedAt: 0, latencyMs: 0, gaps: [] };
const json = (v: unknown): string => JSON.stringify(v);

const GLOSSARY = {
  ...base,
  kind: "glossary",
  query: { term: null, limit: 20 },
  mode: "list",
  entries: [{ term: "vault" }, { term: "brief" }],
  matchedVia: null,
  suggestions: [],
  stats: { total: 9, pending: 2, vetoed: 1, manual: 3, lastPassAt: null },
};

const DECISIONS = {
  ...base,
  kind: "decisions",
  query: { sinceMs: 0, service: null, minConfidence: 0, explain: false },
  entries: [{ id: "d1" }, { id: "d2" }],
  stats: { total: 4, pending: 1, extracted: 3, vetoed: 0, lastPassAt: null, truncatedSources: 2 },
};

const OWNERSHIP_COVERAGE = {
  lastPassAt: null,
  lastDurationMs: 0,
  rootsTotal: 2,
  rootsCovered: 1,
  rootsWithRemote: 1,
  filesCovered: 40,
  filesExcluded: 3,
  servicesBound: 1,
  ownersEmitted: 5,
  entitiesReaped: 0,
};
const OWNERSHIP = {
  ...base,
  kind: "ownership",
  query: { path: null, service: null, itemUrl: null },
  target: null,
  parentDirectory: null,
  service: null,
  coverage: OWNERSHIP_COVERAGE,
};

type Case = readonly [label: string, brief: unknown];

// Why an EMPTY string is in each table below: it is the only JSON value that is iterable but not
// an array and yields no elements, so it is the one input on which the extractors' `Array.isArray`
// guard is observable. A non-empty string already fails per element, and an object is not
// iterable — its throw is caught by `summarizeBrief` and comes back as `undefined` either way.

describe("glossary extractor shape guards", () => {
  test("control: the well-formed brief summarizes", () => {
    expect(summarizeBrief("agents.glossary", json(GLOSSARY))?.keys).toEqual(["brief", "vault"]);
  });

  test.each<Case>([
    ["a brief of another kind", { ...GLOSSARY, kind: "decisions" }],
    ["entries that are not an array", { ...GLOSSARY, entries: "vault,brief" }],
    ["entries that are an empty string, not an empty list", { ...GLOSSARY, entries: "" }],
    [
      "an entry whose term is not a string",
      { ...GLOSSARY, entries: [{ term: "vault" }, { term: 7 }] },
    ],
    ["an entry that is not an object", { ...GLOSSARY, entries: [{ term: "vault" }, null] }],
    ["stats missing one counter", { ...GLOSSARY, stats: { total: 9, pending: 2, vetoed: 1 } }],
    ["a counter that is not a number", { ...GLOSSARY, stats: { ...GLOSSARY.stats, manual: "3" } }],
  ])("%s is not summarizable", (_label, brief) => {
    expect(summarizeBrief("agents.glossary", json(brief))).toBeUndefined();
  });
});

describe("decisions extractor shape guards", () => {
  test("control: the well-formed brief summarizes", () => {
    expect(summarizeBrief("agents.decisions", json(DECISIONS))?.metrics).toMatchObject({
      truncated_sources: 2,
      entries_listed: 2,
    });
  });

  test.each<Case>([
    ["a brief of another kind", { ...DECISIONS, kind: "glossary" }],
    ["entries that are not an array", { ...DECISIONS, entries: { id: "d1" } }],
    ["entries that are an empty string, not an empty list", { ...DECISIONS, entries: "" }],
    ["an entry whose id is not a string", { ...DECISIONS, entries: [{ id: 1 }] }],
    ["no stats object", { ...DECISIONS, stats: null }],
    [
      "stats missing truncatedSources",
      { ...DECISIONS, stats: { total: 4, pending: 1, extracted: 3, vetoed: 0 } },
    ],
  ])("%s is not summarizable", (_label, brief) => {
    expect(summarizeBrief("agents.decisions", json(brief))).toBeUndefined();
  });
});

describe("ownership extractor shape guards", () => {
  test("control: the well-formed coverage-mode brief summarizes to no owners", () => {
    const s = summarizeBrief("agents.ownership", json(OWNERSHIP));
    expect(s?.keys).toEqual([]);
    expect(s?.metrics["files_covered"]).toBe(40);
  });

  test.each<Case>([
    ["a brief of another kind", { ...OWNERSHIP, kind: "standup" }],
    ["no coverage object", { ...OWNERSHIP, coverage: undefined }],
    ["coverage that is an array", { ...OWNERSHIP, coverage: [OWNERSHIP_COVERAGE] }],
    [
      "coverage missing one counter",
      { ...OWNERSHIP, coverage: { ...OWNERSHIP_COVERAGE, entitiesReaped: undefined } },
    ],
  ])("%s is not summarizable", (_label, brief) => {
    expect(summarizeBrief("agents.ownership", json(brief))).toBeUndefined();
  });
});

describe("ghost rank bands", () => {
  test("a rank outside the SDK vocabulary is counted under its own band, beside the zero-seeded ones", () => {
    const brief = {
      ...base,
      kind: "ghost",
      query: { file: "a.ts" },
      startEntityId: null,
      findings: [
        { peerId: "p1", expert: null, rank: "legendary", context: [], suggestedContact: "" },
        { peerId: "p2", expert: null, rank: "legendary", context: [], suggestedContact: "" },
        { peerId: "p3", expert: null, rank: "high", context: [], suggestedContact: "" },
      ],
    };
    expect(summarizeBrief("agents.ghost", json(brief))?.metrics).toEqual({
      ghost_peers: 3,
      context_items: 0,
      rank_high: 1,
      rank_medium: 0,
      rank_low: 0,
      rank_none: 0,
      rank_legendary: 2,
    });
  });
});
