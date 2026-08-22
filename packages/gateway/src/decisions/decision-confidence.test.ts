import { expect, test } from "bun:test";

import { computeConfidence, computePriority, explainConfidence } from "./decision-confidence.ts";

test("a fully-evidenced heading decision on a page scores near 1", () => {
  const c = computeConfidence({
    tier: "heading",
    serviceType: "confluence:page",
    evidenceKinds: ["pr", "migration"],
    hasRationale: true,
    hasAlternatives: true,
  });
  expect(c).toBeCloseTo(1, 5);
});

test("a weak chat cue with no evidence and no rationale scores low", () => {
  const c = computeConfidence({
    tier: "weak",
    serviceType: "slack:message",
    evidenceKinds: [],
    hasRationale: false,
    hasAlternatives: false,
  });
  expect(c).toBeLessThan(0.2);
});

test("migration evidence no longer changes the score, because nothing emits it (F25)", () => {
  // This pinned a branch that could never execute: the union, this scorer and the V47 CHECK are
  // the only three sites the literal appears in, and no writer produces it. Keeping the branch
  // meant PR/commit corroboration scored 0.6 and total confidence capped at 0.86 — a scale on
  // which no real decision could ever score full marks.
  const base = {
    tier: "explicit",
    serviceType: "jira:issue",
    hasRationale: true,
    hasAlternatives: false,
  } as const;
  const pr = computeConfidence({ ...base, evidenceKinds: ["pr"] });
  const both = computeConfidence({ ...base, evidenceKinds: ["pr", "migration"] });
  expect(both).toBeCloseTo(pr, 10);
});

test("confidence never leaves 0..1", () => {
  const c = computeConfidence({
    tier: "heading",
    serviceType: "notion:page",
    evidenceKinds: ["pr", "commit", "migration", "iac", "adr"],
    hasRationale: true,
    hasAlternatives: true,
  });
  expect(c).toBeLessThanOrEqual(1);
  expect(c).toBeGreaterThanOrEqual(0);
});

// `source` is always present (the item the cue came from) and must not be
// mistaken for corroboration, or every decision would score as corroborated.
test("the 'source' evidence kind does not count as corroboration", () => {
  const base = {
    tier: "explicit",
    serviceType: "slack:message",
    hasRationale: false,
    hasAlternatives: false,
  } as const;
  expect(computeConfidence({ ...base, evidenceKinds: ["source"] })).toBe(
    computeConfidence({ ...base, evidenceKinds: [] }),
  );
});

test("priority uses only the terms knowable before extraction", () => {
  const heading = computePriority({ tier: "heading", serviceType: "confluence:page" });
  const weak = computePriority({ tier: "weak", serviceType: "slack:message" });
  expect(heading).toBeGreaterThan(weak);
  // 0.25 * 1.0 + 0.20 * 1.0
  expect(heading).toBeCloseTo(0.45, 5);
});

test("explainConfidence returns one labelled row per term", () => {
  const rows = explainConfidence({
    tier: "heading",
    serviceType: "notion:page",
    evidenceKinds: ["pr"],
    hasRationale: true,
    hasAlternatives: false,
  });
  expect(rows.map((r) => r.term)).toEqual(["cue", "corroboration", "authority", "completeness"]);
});

/**
 * `--explain` prints `explainConfidence`'s four terms beside the score that
 * `computeConfidence` produced. The two are separate code paths — the explainer
 * sums UNCLAMPED, the scorer clamps — and they agree today only because the
 * term ranges happen to bound the sum to [0.1225, 1.0]. Nothing enforced that,
 * so a future weight or range change could ship a breakdown that contradicts
 * the number printed next to it. This is that enforcement.
 */
const CONFIDENCE_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly input: Parameters<typeof computeConfidence>[0];
}> = [
  {
    name: "fully-evidenced heading on a page",
    input: {
      tier: "heading",
      serviceType: "confluence:page",
      evidenceKinds: ["pr", "migration"],
      hasRationale: true,
      hasAlternatives: true,
    },
  },
  {
    name: "weak chat cue, no evidence",
    input: {
      tier: "weak",
      serviceType: "slack:message",
      evidenceKinds: [],
      hasRationale: false,
      hasAlternatives: false,
    },
  },
  {
    name: "explicit ticket cue with PR corroboration",
    input: {
      tier: "explicit",
      serviceType: "jira:issue",
      evidenceKinds: ["pr"],
      hasRationale: true,
      hasAlternatives: false,
    },
  },
  {
    name: "every evidence kind at once",
    input: {
      tier: "heading",
      serviceType: "notion:page",
      evidenceKinds: ["source", "pr", "commit", "migration", "iac", "adr"],
      hasRationale: true,
      hasAlternatives: true,
    },
  },
  {
    name: "source-only evidence",
    input: {
      tier: "explicit",
      serviceType: "slack:message",
      evidenceKinds: ["source"],
      hasRationale: false,
      hasAlternatives: false,
    },
  },
  {
    name: "the reachable ceiling — PR/commit corroboration only",
    input: {
      tier: "heading",
      serviceType: "notion:page",
      evidenceKinds: ["pr", "commit"],
      hasRationale: true,
      hasAlternatives: true,
    },
  },
];

test("explainConfidence terms sum to exactly computeConfidence", () => {
  // Named tuples, not bare numbers, so a failure says WHICH fixture diverged.
  const rows = CONFIDENCE_FIXTURES.map(({ name, input }) => ({
    name,
    sum: explainConfidence(input).reduce((acc, t) => acc + t.value, 0),
  }));
  const expected = CONFIDENCE_FIXTURES.map(({ name, input }) => ({
    name,
    sum: computeConfidence(input),
  }));
  expect(rows).toEqual(expected);
});

// Was 0.86, with a standing gap note in `agents/decisions.ts` explaining why. Both are gone:
// the cap came from `corroboration()` reserving its top score for evidence nothing emits.
test("the reachable confidence ceiling is 1.0 — full marks are attainable", () => {
  const best = computeConfidence({
    tier: "heading",
    serviceType: "notion:page",
    evidenceKinds: ["pr", "commit", "adr", "source"],
    hasRationale: true,
    hasAlternatives: true,
  });
  expect(best).toBeCloseTo(1, 5);
});
