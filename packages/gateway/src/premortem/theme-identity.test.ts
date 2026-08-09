import { expect, test } from "bun:test";

import {
  normalizeThemeLabel,
  THEME_CONFIDENCE_CEILING,
  themeConfidence,
  themeId,
} from "./theme-identity.ts";

test("normalization collapses case, whitespace and edge punctuation", () => {
  expect(normalizeThemeLabel("Rate limits.")).toBe("rate limits");
  expect(normalizeThemeLabel("rate  limits")).toBe("rate limits");
  expect(normalizeThemeLabel("  RATE LIMITS  ")).toBe("rate limits");
  expect(normalizeThemeLabel("\u201crate limits\u201d")).toBe("rate limits");
});

test("normalization does NOT stem or fold synonyms", () => {
  // Deliberate: folding distinct blockers together would destroy the signal the
  // agent exists to surface. If these ever converge, the contract has drifted.
  expect(normalizeThemeLabel("timeout")).not.toBe(normalizeThemeLabel("latency"));
  expect(normalizeThemeLabel("rate limit")).not.toBe(normalizeThemeLabel("rate limiting"));
});

test("the id is content-derived: same service+label always yields the same id", () => {
  expect(themeId("billing-api", "Rate limits.")).toBe(themeId("billing-api", "rate  limits"));
});

test("the id is service-scoped: the same label in two services is two themes", () => {
  expect(themeId("billing-api", "rate limits")).not.toBe(themeId("payments", "rate limits"));
});

test("confidence rises with corroboration and never reaches 1.0", () => {
  // No connector indexes ticket comments (#1128 fetches summary/description/
  // status/dates only), so a blocker argued out entirely in a comment thread is
  // invisible to this pass. Presenting a full-marks scale the user cannot reach
  // is the anti-pattern decisions' 0.86 ceiling exists to avoid.
  expect(themeConfidence(1)).toBeLessThan(themeConfidence(2));
  expect(themeConfidence(2)).toBeLessThan(themeConfidence(5));
  expect(themeConfidence(1000)).toBeLessThanOrEqual(THEME_CONFIDENCE_CEILING);
  expect(THEME_CONFIDENCE_CEILING).toBe(0.86);
});

test("zero evidence is zero confidence, not a floor", () => {
  expect(themeConfidence(0)).toBe(0);
});

test("different labels under the same service produce different ids", () => {
  expect(themeId("billing-api", "rate limits")).not.toBe(themeId("billing-api", "timeout"));
});

test("delimiter-collision: naive single-separator join would merge distinct themes", () => {
  // A bare space delimiter creates a collision: themeId("x y", "z") hashes the same
  // as themeId("x", "y z"). This would silently merge two distinct themes' evidence
  // into the PRIMARY KEY. Length-prefixing eliminates the ambiguity.
  expect(themeId("x y", "z")).not.toBe(themeId("x", "y z"));
});

test("a digit-only service and label cannot collide across the boundary", () => {
  // Length prefixes alone are NOT self-terminating: with an undelimited
  // decimal prefix, ("1","1".repeat(11)) and ("1".repeat(11),"1") both encode
  // to fifteen '1' characters. The ":" terminator closes that class.
  expect(themeId("1", "1".repeat(11))).not.toBe(themeId("1".repeat(11), "1"));
});
