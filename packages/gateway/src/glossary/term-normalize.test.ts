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
