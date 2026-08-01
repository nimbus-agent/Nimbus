import { expect, test } from "bun:test";

import { mineTerms } from "./term-mining.ts";

function keys(text: string): string[] {
  return mineTerms(text)
    .map((c) => c.key)
    .sort();
}

test("family 1 — mines acronyms", () => {
  expect(keys("We ship CDR nightly")).toContain("cdr");
});

test("family 1 — plural acronym collapses to the singular key", () => {
  expect(keys("our SLOs slipped")).toContain("slo");
});

test("family 2 — mines backticked tokens", () => {
  expect(keys("set the `shard_key` first")).toContain("shard_key");
});

test("family 3 — mines PascalCase and camelCase identifiers", () => {
  const k = keys("the RetryBudget guards retryPolicy");
  expect(k).toContain("retrybudget");
  expect(k).toContain("retrypolicy");
});

test("family 4 — mines hyphenated compounds", () => {
  expect(keys("we use write-behind caching")).toContain("write-behind");
});

test("family 5 — mines a mid-sentence capitalized phrase", () => {
  expect(keys("we route Shadow Traffic to staging")).toContain("shadow traffic");
});

test("family 5 — rejects a phrase containing a function word", () => {
  expect(keys("In Addition we shipped")).not.toContain("in addition");
});

test("family 5 — a sentence-initial-only phrase is flagged, not silently kept", () => {
  const c = mineTerms("The Target moved. Nobody noticed.").find((x) => x.key === "the target");
  expect(c).toBeUndefined();
});

test("family 5 — sentenceInitial is false when the phrase also appears mid-sentence", () => {
  const text = "Shadow Traffic is new. We route Shadow Traffic daily.";
  const c = mineTerms(text).find((x) => x.key === "shadow traffic");
  expect(c).toBeDefined();
  expect(c?.sentenceInitial).toBe(false);
});

test("family 5 — a phrase never spans a line break", () => {
  // discoverPhase mines `${title}\n${body_preview}`, so a title ending in a
  // capitalized phrase, above a body opening with another capitalized word,
  // must not fuse into one candidate. The phrase has to sit mid-line for this
  // to bite: a line-initial fabrication is dropped by the sentence-initial
  // rule anyway, which would make the assertion pass for the wrong reason.
  const k = keys("Notes on Shadow Traffic\nMigration plan for the sync path");
  expect(k).not.toContain("shadow traffic migration");
  expect(k).toContain("shadow traffic");
});

test("family 5 — a mid-line phrase survives the line-break boundary", () => {
  // The boundary must not swallow real terminology: the phrase is mid-sentence
  // on its own line, so it is still mined.
  const k = keys("Rollout notes\nWe route Shadow Traffic daily.");
  expect(k).toContain("shadow traffic");
});

test("stopwords are excluded", () => {
  const k = keys("the API returned JSON with `const` values");
  expect(k).not.toContain("api");
  expect(k).not.toContain("json");
  expect(k).not.toContain("const");
});

test("deduplicates repeated terms by key", () => {
  const found = mineTerms("CDR and CDR and CDRs").filter((c) => c.key === "cdr");
  expect(found).toHaveLength(1);
});

test("empty and whitespace input yields no candidates", () => {
  expect(mineTerms("")).toEqual([]);
  expect(mineTerms("   \n  ")).toEqual([]);
});

test("unicode text does not throw", () => {
  expect(() => mineTerms("émission CDR — naïve café")).not.toThrow();
});
