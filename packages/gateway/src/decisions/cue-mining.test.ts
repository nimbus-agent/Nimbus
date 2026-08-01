import { expect, test } from "bun:test";

import { decisionRowId, mineCues, normalizeSentence, splitSentences } from "./cue-mining.ts";

test("normalizeSentence lowercases, collapses whitespace and strips trailing punctuation", () => {
  expect(normalizeSentence("  We   DECIDED to ship!!  ")).toBe("we decided to ship");
});

test("splitSentences splits on sentence terminators and newlines", () => {
  expect(splitSentences("One. Two! Three?\nFour")).toEqual(["One.", "Two!", "Three?", "Four"]);
});

test("tiers a heading cue above an explicit one", () => {
  const heading = mineCues("Decision: adopt Postgres");
  expect(heading).toHaveLength(1);
  expect(heading[0]?.tier).toBe("heading");

  const explicit = mineCues("So we decided to adopt Postgres");
  expect(explicit[0]?.tier).toBe("explicit");
});

test("tiers a bare preference cue as weak", () => {
  expect(mineCues("we'll use Postgres for this")[0]?.tier).toBe("weak");
});

// Negative cases. A cue miner tested only on positives proves nothing about
// precision, and these are the exact false positives the spec calls out.
test("still emits candidates for non-decisions — vetoing them is the LLM's job, not the miner's", () => {
  const hits = mineCues("we decided to grab lunch at noon");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.tier).toBe("explicit");
});

test("emits nothing when no cue is present", () => {
  expect(mineCues("The deploy finished at 14:02 and the dashboard looks fine.")).toEqual([]);
});

test("emits one hit per sentence, not one per cue occurrence", () => {
  expect(mineCues("we decided we decided to move on")).toHaveLength(1);
});

test("row id is stable for the same normalized sentence and differs across items", () => {
  const a = decisionRowId("slack:1", normalizeSentence("We decided to ship."));
  const b = decisionRowId("slack:1", normalizeSentence("  we DECIDED to ship  "));
  const c = decisionRowId("slack:2", normalizeSentence("We decided to ship."));
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("row id ignores edits outside the cue sentence", () => {
  const first = mineCues("Intro text. We decided to ship.");
  const second = mineCues("Intro text, now with a typo fixed. We decided to ship.");
  expect(first[0]).toBeDefined();
  expect(second[0]).toBeDefined();
  expect(decisionRowId("i1", first[0]!.normalized)).toBe(
    decisionRowId("i1", second[0]!.normalized),
  );
});
