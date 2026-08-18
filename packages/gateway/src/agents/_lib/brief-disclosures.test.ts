import { describe, expect, test } from "bun:test";
import { contractViolations, requiredPhrases } from "./brief-contract.ts";
import type { GlossaryBrief, GlossaryEntry } from "./glossary-types.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import { renderGlossary, renderNegotiate } from "./render.ts";

/**
 * Drop every LINE containing `fragment`, and THROW if nothing was dropped.
 *
 * A mutation helper that silently no-ops builds a fixture that proves nothing: the
 * "rejects a dropped disclosure" test would run against unmodified canonical markdown,
 * pass because the disclosure is still there, and report a working guard either way.
 * This repo has shipped exactly that defect, so the helper fails loudly instead.
 */
function withoutLine(markdown: string, fragment: string): string {
  const out = markdown
    .split("\n")
    .filter((l) => !l.includes(fragment))
    .join("\n");
  if (out === markdown) throw new Error(`fixture dropped nothing containing "${fragment}"`);
  return out;
}

/**
 * EVERY lane non-null and every conditional disclosure triggered — `ownership.truncated`,
 * `incidents.unattributable > 0`, `decisions.unattributable`. A fixture with null lanes
 * would exercise only the "_could not be computed_" anchor that already had a guard and
 * leave all six new ones untested with the suite green.
 */
function populatedNegotiateBrief(): NegotiateBrief {
  const evidence = { refs: [], total: 0 } as const;
  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [],
    query: { sinceMs: 1_000 },
    subject: { personId: "p-1", source: "git", displayName: "Ann", isOther: false },
    sources: {
      personalDocsConfigured: false,
      personalDocsRecognised: [],
      personalDocsUnrecognised: [],
      personalDocsConfigKey: "negotiate.personal_sources",
    },
    unavailableEvidence: [],
    authoredPrs: {
      count: 4,
      merged: 2,
      evidence,
      stats: null,
      statsCoverage: { covered: 0, total: 0 },
    },
    reviewedPrs: { count: 2, approved: 1, changesRequested: 0, otherOrUnknown: 1, evidence },
    incidents: { resolved: 1, assigned: 0, unattributable: 3, errorIssuesAssigned: 0, evidence },
    tickets: { opened: 1, closedByAuthoredPr: 0, evidence },
    ownership: {
      services: ["checkout"],
      directories: [],
      lastPassAt: null,
      truncated: true,
      unmappedIdentitiesInIndex: 0,
    },
    decisions: { authored: 2, unattributable: 1, evidence },
    writing: { docs: 1, notes: 0, messages: 0, evidence },
  };
}

function glossaryEntry(overrides: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    term: "CDR",
    definition: "A thing.",
    definitionSource: "manual",
    docFreq: 0,
    serviceSpread: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
    topSources: [],
    synonyms: [],
    nearMisses: [],
    ...overrides,
  };
}

function glossaryBrief(entries: GlossaryEntry[]): GlossaryBrief {
  return {
    kind: "glossary",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 800,
    gaps: [],
    query: { term: entries[0]?.term ?? null, limit: 10 },
    mode: "term",
    entries,
    matchedVia: null,
    suggestions: [],
    stats: {
      total: entries.length,
      pending: 0,
      vetoed: 0,
      manual: 1,
      lastPassAt: null,
      truncatedSources: 0,
    },
  };
}

describe("negotiate interleaved disclosures", () => {
  // FIXTURE INTEGRITY, same role as brief-contract.test.ts's seven-lane assertion: if a
  // predicate stops firing, requiredPhrases silently returns fewer entries and every
  // "rejects" test below still passes while guarding nothing.
  test("derives one requirement per interleaved disclosure — all five", () => {
    expect(requiredPhrases(populatedNegotiateBrief()).length).toBe(5);
  });

  test("the canonical render satisfies every requirement", () => {
    const brief = populatedNegotiateBrief();
    expect(contractViolations(brief, renderNegotiate(brief))).toEqual([]);
  });

  test("rejects a rewrite that drops the authorship-derived ownership disclaimer", () => {
    const brief = populatedNegotiateBrief();
    const md = withoutLine(renderNegotiate(brief), "authorship-derived");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Ownership");
  });

  test("rejects a rewrite that drops the ownership list-truncation clause", () => {
    const brief = populatedNegotiateBrief();
    const md = withoutLine(renderNegotiate(brief), "list truncated at the display limit");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Ownership");
  });

  test("rejects a rewrite that drops the unattributable-incidents clause", () => {
    const brief = populatedNegotiateBrief();
    const md = withoutLine(renderNegotiate(brief), "no indexed assignee or resolver");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Incidents");
  });

  test("rejects a rewrite that drops the unattributable-decisions clause", () => {
    const brief = populatedNegotiateBrief();
    const md = withoutLine(renderNegotiate(brief), "no indexed author");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Decisions");
  });

  test("rejects a rewrite that drops the last-modified window clause from the preamble", () => {
    // The clause every headline count in the brief depends on: without it "4 PR(s)" reads as
    // "4 authored this quarter" when the query means "authored at any time, TOUCHED in this
    // window" — a systematic overstatement. It lives above the first `##`, so a section-scoped
    // requirement cannot reach it.
    const brief = populatedNegotiateBrief();
    const md = withoutLine(renderNegotiate(brief), "last-modified, not created");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("preamble");
  });

  test("the window clause cannot be satisfied from inside a section", () => {
    // Preamble scope, not a document-wide substring search: a rewrite that deletes the
    // clause from the header and mentions it under some section has still dropped the
    // disclosure from the place every count below it is read against.
    const brief = populatedNegotiateBrief();
    const md = `${withoutLine(renderNegotiate(brief), "last-modified, not created")}\n\n## Notes\n\nthe index records last-modified, not created`;
    expect(contractViolations(brief, md).length).toBe(1);
  });

  test("a truncation clause is required only when the list WAS truncated", () => {
    // The inverse defect: requiring a phrase the renderer never emits would reject every
    // synthesis of an untruncated brief — the guard failing open into failing useless.
    const brief = populatedNegotiateBrief();
    const untruncated = {
      ...brief,
      ownership: { ...brief.ownership, truncated: false },
    } as NegotiateBrief;
    expect(requiredPhrases(untruncated).length).toBe(4);
    expect(contractViolations(untruncated, renderNegotiate(untruncated))).toEqual([]);
  });

  test("an unattributable clause is required only when the count is non-zero", () => {
    const brief = populatedNegotiateBrief();
    const none = {
      ...brief,
      incidents: { ...brief.incidents, unattributable: 0 },
    } as NegotiateBrief;
    expect(requiredPhrases(none).length).toBe(4);
    expect(contractViolations(none, renderNegotiate(none))).toEqual([]);
  });
});

describe("glossary definition-provenance disclosures", () => {
  test("the canonical render satisfies the entry's provenance requirement", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "manual" })]);
    expect(requiredPhrases(brief).length).toBe(1);
    expect(contractViolations(brief, renderGlossary(brief))).toEqual([]);
  });

  test("rejects a rewrite that drops the authored-in-config provenance line", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "manual" })]);
    const md = withoutLine(renderGlossary(brief), "not derived from indexed sources");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("CDR");
  });

  test("rejects a rewrite that drops the no-LLM snippet provenance line", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "snippet" })]);
    const md = withoutLine(renderGlossary(brief), "no LLM configured");
    const v = contractViolations(brief, md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("CDR");
  });

  test("an LLM-written definition requires nothing — it has no provenance caveat to keep", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "llm" })]);
    expect(requiredPhrases(brief)).toEqual([]);
  });

  test("requires nothing beyond the FIRST entry — term mode renders only that one", () => {
    // `renderGlossaryBody` takes `entries[0]` and ignores the rest. A requirement derived
    // from a later entry would name a `## <term>` section the brief never rendered, so every
    // violation report would be "missing required section" and no glossary rewrite could
    // ever be accepted.
    const brief = glossaryBrief([
      glossaryEntry({ term: "CDR", definitionSource: "llm" }),
      glossaryEntry({ term: "widget", definitionSource: "snippet" }),
    ]);
    expect(requiredPhrases(brief)).toEqual([]);
    expect(contractViolations(brief, renderGlossary(brief))).toEqual([]);
  });

  test("list mode requires nothing — its entries carry no provenance sentence", () => {
    // The same false-positive risk from the other direction: `renderGlossaryList` writes one
    // line per entry and no provenance caveat at all, so requiring one would reject every
    // list-mode synthesis over a disclosure the renderer never wrote.
    const brief = {
      ...glossaryBrief([glossaryEntry({ definitionSource: "manual" })]),
      mode: "list" as const,
    };
    expect(requiredPhrases(brief)).toEqual([]);
    expect(contractViolations(brief, renderGlossary(brief))).toEqual([]);
  });
});
