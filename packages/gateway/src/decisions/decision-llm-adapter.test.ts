import { expect, test } from "bun:test";

import {
  buildExtractionPrompt,
  type DecisionLlm,
  extractDecision,
  parseExtraction,
} from "./decision-llm-adapter.ts";

function fakeLlm(reply: string): DecisionLlm {
  return { complete: async () => reply };
}

test("the prompt contains the sentence and demands strict JSON", () => {
  const p = buildExtractionPrompt("We decided to adopt Postgres.", "surrounding text");
  expect(p).toContain("We decided to adopt Postgres.");
  expect(p).toContain("JSON");
});

test("parses a decision with rationale and alternatives", () => {
  const out = parseExtraction(
    '{"is_decision":true,"statement":"Adopt Postgres","rationale":"pool exhaustion","alternatives":["MySQL","shard"]}',
  );
  expect(out).toEqual({
    kind: "decision",
    statement: "Adopt Postgres",
    rationale: "pool exhaustion",
    alternatives: ["MySQL", "shard"],
  });
});

test("parses a veto", () => {
  expect(parseExtraction('{"is_decision":false}')).toEqual({ kind: "veto" });
});

test("tolerates a model that wraps JSON in prose or a fenced block", () => {
  const out = parseExtraction(
    'Sure!\n```json\n{"is_decision":true,"statement":"Adopt Postgres"}\n```\nHope that helps.',
  );
  expect(out.kind).toBe("decision");
});

// A local model returning junk must be a VETO-free failure: the row stays
// pending and retries with backoff. Silently treating garbage as a veto would
// permanently discard a real decision.
test("throws on unparseable output rather than vetoing", () => {
  expect(() => parseExtraction("I could not determine that.")).toThrow();
});

test("throws when is_decision is true but no statement is given", () => {
  expect(() => parseExtraction('{"is_decision":true}')).toThrow();
});

test('throws when is_decision is the string "true" rather than a boolean', () => {
  expect(() => parseExtraction('{"is_decision":"true","statement":"X"}')).toThrow();
});

test("throws when is_decision is absent", () => {
  expect(() => parseExtraction('{"statement":"X"}')).toThrow();
});

test("throws when is_decision is a number", () => {
  expect(() => parseExtraction('{"is_decision":1,"statement":"X"}')).toThrow();
});

test("a non-array alternatives field degrades to an empty list", () => {
  const out = parseExtraction('{"is_decision":true,"statement":"X","alternatives":"nope"}');
  expect(out).toEqual({ kind: "decision", statement: "X", rationale: null, alternatives: [] });
});

test("extractDecision round-trips through an injected llm", async () => {
  const out = await extractDecision(
    fakeLlm('{"is_decision":true,"statement":"Adopt Postgres"}'),
    "We decided to adopt Postgres.",
    "ctx",
  );
  expect(out.kind).toBe("decision");
});
