import { expect, test } from "bun:test";

import { detectAcronymExpansions, findNearMisses } from "./near-miss.ts";

test("detects an expansion followed by a parenthesized acronym", () => {
  const found = detectAcronymExpansions("we adopted Change Data Record (CDR) last year");
  expect(found).toEqual([{ acronymKey: "cdr", expansion: "Change Data Record" }]);
});

test("ignores a parenthesized acronym whose initials do not match", () => {
  expect(detectAcronymExpansions("Some Other Words (XYZ) here")).toEqual([]);
});

test("returns an empty array when there is no pattern", () => {
  expect(detectAcronymExpansions("nothing to see")).toEqual([]);
});

test("finds keys within edit distance two", () => {
  expect(findNearMisses("cdr", ["cdc", "sre", "cdrs"])).toContain("cdc");
});

test("never returns the term itself", () => {
  expect(findNearMisses("cdr", ["cdr", "cdc"])).not.toContain("cdr");
});

test("excludes keys beyond edit distance two", () => {
  expect(findNearMisses("cdr", ["deployment"])).toEqual([]);
});

test("respects the limit", () => {
  const out = findNearMisses("cdr", ["cdc", "cdx", "cdq", "cds"], 2);
  expect(out.length).toBe(2);
});

test("handles an empty known list", () => {
  expect(findNearMisses("cdr", [])).toEqual([]);
});
