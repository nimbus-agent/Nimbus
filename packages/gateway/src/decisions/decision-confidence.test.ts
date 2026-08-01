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

test("adding a migration to a PR raises corroboration", () => {
  const base = {
    tier: "explicit",
    serviceType: "jira:issue",
    hasRationale: true,
    hasAlternatives: false,
  } as const;
  const pr = computeConfidence({ ...base, evidenceKinds: ["pr"] });
  const both = computeConfidence({ ...base, evidenceKinds: ["pr", "migration"] });
  expect(both).toBeGreaterThan(pr);
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
