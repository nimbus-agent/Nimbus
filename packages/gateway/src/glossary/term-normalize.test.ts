import { expect, test } from "bun:test";

import { normalizeTerm } from "./term-normalize.ts";

test("lowercases", () => {
  expect(normalizeTerm("CDR")).toBe("cdr");
  expect(normalizeTerm("Shadow Traffic")).toBe("shadow traffic");
});

test("strips backticks and surrounding punctuation", () => {
  expect(normalizeTerm("`shard_key`")).toBe("shard_key");
  expect(normalizeTerm("(CDR)")).toBe("cdr");
  expect(normalizeTerm("CDR,")).toBe("cdr");
});

test("collapses internal whitespace", () => {
  expect(normalizeTerm("Shadow   Traffic")).toBe("shadow traffic");
  expect(normalizeTerm("  CDR  ")).toBe("cdr");
});

test("removes a trailing plural s", () => {
  expect(normalizeTerm("SLOs")).toBe("slo");
  expect(normalizeTerm("CDRs")).toBe("cdr");
});

test("does not strip s from a short or ss-ending word", () => {
  expect(normalizeTerm("as")).toBe("as");
  expect(normalizeTerm("class")).toBe("class");
  expect(normalizeTerm("status")).toBe("status");
});

test("plural and singular collapse to one key", () => {
  expect(normalizeTerm("SLOs")).toBe(normalizeTerm("SLO"));
});

test("returns empty string for meaningless input", () => {
  expect(normalizeTerm("")).toBe("");
  expect(normalizeTerm("   ")).toBe("");
  expect(normalizeTerm("``")).toBe("");
  expect(normalizeTerm("-")).toBe("");
});

test("preserves internal underscores and hyphens", () => {
  expect(normalizeTerm("shard_key")).toBe("shard_key");
  expect(normalizeTerm("write-behind")).toBe("write-behind");
});

test("strips curly quotes as well as straight ones", () => {
  expect(normalizeTerm("\u{201C}CDR\u{201D}")).toBe("cdr");
  expect(normalizeTerm("\u{2018}CDR\u{2019}")).toBe("cdr");
});

test("does not strip s from words ending in is", () => {
  expect(normalizeTerm("axis")).toBe("axis");
});

test("does not strip s from a word carrying an internal dot", () => {
  expect(normalizeTerm("node.js")).toBe("node.js");
  expect(normalizeTerm("next.js")).toBe("next.js");
  expect(normalizeTerm("d3.js")).toBe("d3.js");
});

// Regression pins: the internal-dot exemption must not weaken the ordinary
// plural rule for undotted words. These are the headline cases the function
// exists for — a fix for the dotted-identifier case that broadens the rule
// (e.g. "any consonant + s") would break these silently.
test("still strips a trailing plural s from ordinary words", () => {
  expect(normalizeTerm("SLOs")).toBe("slo");
  expect(normalizeTerm("docs")).toBe("doc");
});

test("still keeps ss/us/is endings intact with no internal dot", () => {
  expect(normalizeTerm("class")).toBe("class");
  expect(normalizeTerm("bus")).toBe("bus");
  expect(normalizeTerm("analysis")).toBe("analysis");
});
