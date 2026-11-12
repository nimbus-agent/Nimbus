import { describe, expect, test } from "bun:test";

import { matchesDataModelGlob } from "./data-model-glob.ts";

describe("matchesDataModelGlob", () => {
  test("a glob without a star is an exact match", () => {
    expect(matchesDataModelGlob("a.b.c", "a.b.c")).toBe(true);
    expect(matchesDataModelGlob("a.b.c", "a.b.cd")).toBe(false);
    expect(matchesDataModelGlob("a.b.c", "xa.b.c")).toBe(false);
  });

  test("a star matches any run of characters, dots included, and the empty run", () => {
    expect(matchesDataModelGlob("analytics.payments.*", "analytics.payments.orders")).toBe(true);
    expect(matchesDataModelGlob("analytics.payments.*", "analytics.payments.")).toBe(true);
    expect(matchesDataModelGlob("analytics.*", "analytics.payments.orders.v2")).toBe(true);
    expect(matchesDataModelGlob("*.orders", "x.y.orders")).toBe(true);
  });

  test("the match is anchored at both ends", () => {
    expect(matchesDataModelGlob("a.*", "a")).toBe(false);
    expect(matchesDataModelGlob("*.orders", "x.orders.old")).toBe(false);
    expect(matchesDataModelGlob("pay*", "xpay")).toBe(false);
    expect(matchesDataModelGlob("*pay", "pay-x")).toBe(false);
  });

  test("literal segments must appear in order and not overlap", () => {
    expect(matchesDataModelGlob("a*b*c", "a-b-c")).toBe(true);
    expect(matchesDataModelGlob("a*b*c", "a-c-b")).toBe(false);
    expect(matchesDataModelGlob("a*b*c", "abc")).toBe(true);
    // The prefix and the suffix may not share characters.
    expect(matchesDataModelGlob("ab*ba", "aba")).toBe(false);
    expect(matchesDataModelGlob("ab*ba", "abba")).toBe(true);
    expect(matchesDataModelGlob("a*a*a", "aa")).toBe(false);
    expect(matchesDataModelGlob("a*a*a", "aaa")).toBe(true);
  });

  test("adjacent stars behave as one", () => {
    expect(matchesDataModelGlob("a**b", "axxb")).toBe(true);
    expect(matchesDataModelGlob("**", "anything")).toBe(true);
  });

  test("adversarial inputs finish in linear time (no regular expression is built)", () => {
    const manyStars = `${"*".repeat(10_000)}x`;
    const longKey = "a".repeat(100_000);
    const start = performance.now();
    expect(matchesDataModelGlob(manyStars, longKey)).toBe(false);
    expect(matchesDataModelGlob(`${"a*".repeat(100)}b`, longKey)).toBe(false);
    expect(matchesDataModelGlob("*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(5_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
