import { expect, test } from "bun:test";

import { FORM_BOOST, scoreTerm } from "./term-scoring.ts";

test("score rises with document frequency", () => {
  const low = scoreTerm({ docFreq: 3, serviceSpread: 1, form: "phrase" });
  const high = scoreTerm({ docFreq: 30, serviceSpread: 1, form: "phrase" });
  expect(high).toBeGreaterThan(low);
});

test("score rises with service spread at equal frequency", () => {
  const one = scoreTerm({ docFreq: 10, serviceSpread: 1, form: "phrase" });
  const three = scoreTerm({ docFreq: 10, serviceSpread: 3, form: "phrase" });
  expect(three).toBeGreaterThan(one);
});

test("acronyms outrank phrases at identical statistics", () => {
  const acronym = scoreTerm({ docFreq: 10, serviceSpread: 2, form: "acronym" });
  const phrase = scoreTerm({ docFreq: 10, serviceSpread: 2, form: "phrase" });
  expect(acronym).toBeGreaterThan(phrase);
});

test("form boosts are ordered acronym > code > identifier > hyphenated > phrase", () => {
  expect(FORM_BOOST.acronym).toBeGreaterThan(FORM_BOOST.code);
  expect(FORM_BOOST.code).toBeGreaterThan(FORM_BOOST.identifier);
  expect(FORM_BOOST.identifier).toBeGreaterThan(FORM_BOOST.hyphenated);
  expect(FORM_BOOST.hyphenated).toBeGreaterThan(FORM_BOOST.phrase);
});

test("zero frequency scores zero", () => {
  expect(scoreTerm({ docFreq: 0, serviceSpread: 0, form: "acronym" })).toBe(0);
});

test("a spread below one never reduces the score", () => {
  const s = scoreTerm({ docFreq: 5, serviceSpread: 0, form: "phrase" });
  expect(s).toBeGreaterThan(0);
});

test("score is finite for large inputs", () => {
  expect(Number.isFinite(scoreTerm({ docFreq: 1e6, serviceSpread: 50, form: "acronym" }))).toBe(
    true,
  );
});
