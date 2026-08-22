import { describe, expect, test } from "bun:test";

import { isFunctionWord, isStopword, STOPWORDS } from "./stopwords.ts";

test("layer 1 — common English is a stopword", () => {
  expect(isStopword("the")).toBe(true);
  expect(isStopword("and")).toBe(true);
});

test("layer 2 — ubiquitous tech vocabulary is a stopword", () => {
  for (const t of ["api", "http", "json", "todo", "pr", "ci", "sdk", "url"]) {
    expect(isStopword(t)).toBe(true);
  }
});

test("layer 3 — language keywords are stopwords", () => {
  for (const t of [
    "const",
    "import",
    "return",
    "async",
    "await",
    "function",
    "class",
    "interface",
    "struct",
    "impl",
    "def",
    "select",
    "where",
    "null",
  ]) {
    expect(isStopword(t)).toBe(true);
  }
});

test("real domain jargon is NOT a stopword", () => {
  for (const t of ["cdr", "shadow traffic", "retry budget", "shard_key"]) {
    expect(isStopword(t)).toBe(false);
  }
});

test("isFunctionWord covers articles, prepositions, conjunctions and pronouns", () => {
  for (const w of [
    "the",
    "a",
    "an",
    "in",
    "on",
    "at",
    "of",
    "for",
    "and",
    "or",
    "but",
    "it",
    "we",
    "they",
  ]) {
    expect(isFunctionWord(w)).toBe(true);
  }
  expect(isFunctionWord("shadow")).toBe(false);
});

test("lookups are case-insensitive on already-lowercased input only", () => {
  expect(isStopword("const")).toBe(true);
  expect(isStopword("CONST")).toBe(false);
});

test("STOPWORDS covers all three layers at a meaningful size", () => {
  expect(STOPWORDS.size).toBeGreaterThan(100);
  // One representative per layer, proving the set is actually composed of all
  // three rather than one layer repeated.
  expect(STOPWORDS.has("the")).toBe(true);
  expect(STOPWORDS.has("json")).toBe(true);
  expect(STOPWORDS.has("impl")).toBe(true);
});

describe("headings-harvested noise is filtered (F5)", () => {
  // A real 13,183-item index produced a glossary whose top ten included "main" (21), "Key" (4),
  // "start" (3), "built-in" (7) and "read-only" (3). They are markdown-heading words, not team
  // terminology — the list they crowded out is the product.
  test.each([["main"], ["key"], ["start"], ["built-in"], ["read-only"]])(
    "%s is a stopword",
    (word) => {
      expect(STOPWORDS.has(word)).toBe(true);
    },
  );

  test("a real product term is NOT filtered", () => {
    // The other direction: a stopword list that grows until it eats the answer is worse than one
    // that lets some noise through.
    expect(STOPWORDS.has("whypeek")).toBe(false);
    expect(STOPWORDS.has("egress ledger")).toBe(false);
  });
});
