import type { PrereviewBrief } from "../../agents/_lib/prreview-types.ts";

/** A complete `pr_prereview` brief with every lane populated, for render and reserved-section tests. */
export function buildPrereviewFixture(over: Partial<PrereviewBrief> = {}): PrereviewBrief {
  const example = {
    itemId: "github:acme/app#10",
    title: "Add the payments index",
    url: "https://github.com/acme/app/pull/10",
    mergedAtMs: Date.UTC(2026, 9, 1),
  };
  return {
    kind: "pr_prereview",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [
      {
        category: "missing_relation_emit",
        detail: "These checks come from co-change and your own past reviews.",
      },
    ],
    target: {
      itemId: "github:acme/app#42",
      service: "github",
      repo: "acme/app",
      number: 42,
      title: "Change the index schema",
      url: "https://github.com/acme/app/pull/42",
      state: "open",
      files: ["src/index/schema.ts"],
      filesCovered: true,
      filesTruncated: false,
      apiFileCount: 1,
    },
    coChanges: [
      {
        area: "src/index",
        companion: "docs/architecture.md",
        companionKind: "file",
        count: 7,
        cohort: 9,
        examples: [example],
      },
    ],
    reviewNotes: [
      {
        pr: example,
        state: "CHANGES_REQUESTED",
        reviewedAtMs: Date.UTC(2026, 9, 2),
        body: "Please add a migration test for this.",
      },
    ],
    reviewTerms: [{ term: "migration", reviews: 3 }],
    size: { total: 120, cohortMedian: 40, percentile: 88, comparable: 9 },
    counts: {
      historyUsed: 9,
      historyNoCoverage: 0,
      historyTruncated: 0,
      areasTotal: 1,
      areasCut: 0,
      areasThinHistory: 0,
      findingsCut: 0,
      reviewsMatched: 1,
    },
    ...over,
  };
}
