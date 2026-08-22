import { describe, expect, test } from "bun:test";
import { contractViolations, requiredPhrases } from "./brief-contract.ts";
import type { GlossaryBrief, GlossaryEntry } from "./glossary-types.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import { renderGlossary, renderNegotiate, renderWhy } from "./render.ts";
import type { WhyBrief } from "./why-types.ts";

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
    score: 0.5,
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
    expect(requiredPhrases(populatedNegotiateBrief())).toHaveLength(5);
  });

  test("the canonical render satisfies every requirement", () => {
    const brief = populatedNegotiateBrief();
    expect(contractViolations(brief, renderNegotiate(brief))).toEqual([]);
  });

  // One row per interleaved disclosure counted above: the clause, the fragment `withoutLine`
  // deletes it by, and the scope the resulting violation must name. Deleting any one of them
  // must produce exactly one violation — never zero (the guard is inert) and never two (a
  // deletion that took an unrelated disclosure with it).
  //
  // The window-clause row is the one that is not section-scoped. It is the clause every
  // headline count in the brief depends on: without it "4 PR(s)" reads as "4 authored this
  // quarter" when the query means "authored at any time, TOUCHED in this window" — a
  // systematic overstatement. It lives above the first `##`, so its scope is the preamble.
  test.each([
    ["the authorship-derived ownership disclaimer", "authorship-derived", "Ownership"],
    ["the ownership list-truncation clause", "list truncated at the display limit", "Ownership"],
    ["the unattributable-incidents clause", "no indexed assignee or resolver", "Incidents"],
    ["the unattributable-decisions clause", "no indexed author", "Decisions"],
    ["the last-modified window clause from the preamble", "last-modified, not created", "preamble"],
  ])("rejects a rewrite that drops %s", (_clause, fragment, scope) => {
    const brief = populatedNegotiateBrief();
    const md = withoutLine(renderNegotiate(brief), fragment);
    const v = contractViolations(brief, md);
    // Deleting the LINE drops every anchor on it, and each is reported separately (F27) — a
    // two-sentence disclosure yields two violations. Derived from the disclosure rather than
    // hardcoded, so this still fails if a deletion takes an UNRELATED disclosure with it, which
    // is what the original `toHaveLength(1)` was really guarding.
    const owner = requiredPhrases(brief).find((d) => d.line.includes(fragment));
    expect(owner).toBeDefined();
    expect(v).toHaveLength(owner?.anchors.length ?? 0);
    for (const violation of v) expect(violation).toContain(scope);
  });

  test("the window clause cannot be satisfied from inside a section", () => {
    // Preamble scope, not a document-wide substring search: a rewrite that deletes the
    // clause from the header and mentions it under some section has still dropped the
    // disclosure from the place every count below it is read against.
    const brief = populatedNegotiateBrief();
    const md = `${withoutLine(renderNegotiate(brief), "last-modified, not created")}\n\n## Notes\n\nthe index records last-modified, not created`;
    // Both of the window entry's anchors are still missing FROM THE PREAMBLE: re-stating one of
    // them under a section satisfies neither, because preamble scope is not a document-wide
    // substring search (F27 made this two anchors, not one).
    const windowEntry = requiredPhrases(brief).find((d) => d.scope.kind === "preamble");
    expect(contractViolations(brief, md)).toHaveLength(windowEntry?.anchors.length ?? 0);
  });

  test("a truncation clause is required only when the list WAS truncated", () => {
    // The inverse defect: requiring a phrase the renderer never emits would reject every
    // synthesis of an untruncated brief — the guard failing open into failing useless.
    const brief = populatedNegotiateBrief();
    const untruncated = {
      ...brief,
      ownership: { ...brief.ownership, truncated: false },
    } as NegotiateBrief;
    expect(requiredPhrases(untruncated)).toHaveLength(4);
    expect(contractViolations(untruncated, renderNegotiate(untruncated))).toEqual([]);
  });

  test("an unattributable clause is required only when the count is non-zero", () => {
    const brief = populatedNegotiateBrief();
    const none = {
      ...brief,
      incidents: { ...brief.incidents, unattributable: 0 },
    } as NegotiateBrief;
    expect(requiredPhrases(none)).toHaveLength(4);
    expect(contractViolations(none, renderNegotiate(none))).toEqual([]);
  });
});

describe("glossary definition-provenance disclosures", () => {
  test("the canonical render satisfies the entry's provenance requirement", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "manual" })]);
    expect(requiredPhrases(brief)).toHaveLength(1);
    expect(contractViolations(brief, renderGlossary(brief))).toEqual([]);
  });

  test("rejects a rewrite that drops the authored-in-config provenance line", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "manual" })]);
    const md = withoutLine(renderGlossary(brief), "not derived from indexed sources");
    const v = contractViolations(brief, md);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("CDR");
  });

  test("rejects a rewrite that drops the no-LLM snippet provenance line", () => {
    const brief = glossaryBrief([glossaryEntry({ term: "CDR", definitionSource: "snippet" })]);
    const md = withoutLine(renderGlossary(brief), "no LLM configured");
    const v = contractViolations(brief, md);
    expect(v).toHaveLength(1);
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

function whyBriefWithChangeSubject(): WhyBrief {
  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [],
    query: { ref: "https://github.com/acme/web/pull/482", line: null },
    subject: null,
    changeSubject: {
      itemId: "github:acme/web#482",
      entityId: "e-1",
      repo: "acme/web",
      number: 482,
      url: "https://github.com/acme/web/pull/482",
      title: "Fix retry backoff",
      modifiedAt: 1_700_000_000_000,
    },
    findings: [],
  };
}

describe("why change-subject disclosure", () => {
  // Same fixture-integrity role as the negotiate/glossary tests above: if the predicate stops
  // firing, requiredPhrases silently returns [] and the "rejects" test below passes while
  // guarding nothing.
  test("a resolved change subject requires the lane-caveat disclosure", () => {
    expect(requiredPhrases(whyBriefWithChangeSubject())).toHaveLength(1);
  });

  test("the canonical render satisfies the requirement", () => {
    const brief = whyBriefWithChangeSubject();
    expect(contractViolations(brief, renderWhy(brief))).toEqual([]);
  });

  test("a synthesised rewrite that drops the disclosure is rejected", () => {
    // This is the bug I31 PR 1 closed for negotiate/glossary and this branch reopened for
    // `why`: `ctx.runner` set means an LLM rewrite of the preamble prose is possible, and
    // without this requirement it could drop "authorship needs a line" silently, leaving a
    // brief two lanes shorter than the deterministic one with no explanation.
    const brief = whyBriefWithChangeSubject();
    const md = withoutLine(renderWhy(brief), "authorship needs a line");
    const v = contractViolations(brief, md);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("preamble");
  });

  test("a null changeSubject (miss) requires nothing — its own line is a different disclosure", () => {
    const brief = { ...whyBriefWithChangeSubject(), changeSubject: null };
    expect(requiredPhrases(brief)).toEqual([]);
  });

  test("an absent changeSubject (the ref arm) requires nothing", () => {
    const { changeSubject: _drop, ...rest } = whyBriefWithChangeSubject();
    const brief = rest as WhyBrief;
    expect(requiredPhrases(brief)).toEqual([]);
  });
});

describe("a rewrite that drops only sentence 2 is rejected (F27)", () => {
  /**
   * The audit's red-prove, verbatim: "feed `contractViolations` a rewrite with sentence 2
   * removed; it must fail. Today it passes."
   *
   * This is the shape observed live. An accepted `negotiate` synthesis kept "the index records
   * last-modified, not created" and dropped "Two lanes sit outside it: decisions windows on its
   * recorded decision date, and ownership is not windowed at all" — so the brief shipped telling
   * a reader that "last 90d" applied to an all-time ownership snapshot.
   *
   * The surviving anchor was not in the dropped sentence at all, which is sharper than the bound
   * the I31 docs already concede ("a phrase check proves a fragment survived, not that its
   * sentence still means the same thing").
   */
  test("keeping sentence 1 of the window clause is no longer enough", () => {
    const brief = populatedNegotiateBrief();
    const truncated = renderNegotiate(brief).replace(
      /_window:[^\n]*_/,
      "_window: last 90d — the index records last-modified, not created._",
    );
    expect(truncated).toContain("last-modified, not created");
    expect(truncated).not.toContain("Two lanes sit outside it");

    const violations = contractViolations(brief, truncated);
    expect(violations.some((v) => v.includes("Two lanes sit outside it"))).toBe(true);
  });

  test("keeping sentence 1 of the ownership clause is no longer enough", () => {
    const brief = populatedNegotiateBrief();
    const truncated = renderNegotiate(brief).replace(
      /- this is authorship-derived ownership[^\n]*/,
      "- this is authorship-derived ownership — who wrote the lines, not who is formally accountable.",
    );
    expect(truncated).toContain("authorship-derived");
    expect(truncated).not.toContain("no CODEOWNERS");

    const violations = contractViolations(brief, truncated);
    expect(violations.some((v) => v.includes("CODEOWNERS"))).toBe(true);
  });
});
