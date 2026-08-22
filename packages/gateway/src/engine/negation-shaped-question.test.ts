import { describe, expect, test } from "bun:test";

import {
  isNegationShapedQuestion,
  NEGATION_TOOLS_UNAVAILABLE_LINE,
} from "./negation-shaped-question.ts";

describe("isNegationShapedQuestion (F21)", () => {
  test.each([
    ["which PRs did not touch packages/gateway?", "the audit's own row 3"],
    ["show me deployments with no downstream incident", "the audit's row 2 — query REFUSES this"],
    ["who has never reviewed anything?", "the audit's row 1 — ask said 'No one.'"],
    ["list people who haven't reviewed a PR", "contraction form"],
    ["deployments without an incident", "without"],
    ["nobody reviewed this PR, right?", "nobody"],
    ["PRs not touching src", "bare not-touching"],
    ["run --no-downstream-incident for me", "a pasted flag"],
  ])("fires on %s (%s)", (q) => {
    expect(isNegationShapedQuestion(q)).toBe(true);
  });

  test.each([
    ["what changed in packages/gateway last week?", "an ordinary question about the same subject"],
    ["summarise the most recent deployment", "a positive question"],
    ["I'm not sure what this PR does — explain it", "a hedge, not a negation query"],
    ["who reviewed this PR?", "the positive form of a covered question"],
    ["", "empty"],
  ])("stays quiet on %s (%s)", (q) => {
    expect(isNegationShapedQuestion(q)).toBe(false);
  });

  test("a negative with no covered subject does not fire", () => {
    // The subject gate is what keeps this from becoming noise on every hedged sentence. There is
    // no predicate for "documents I have not read", so claiming one was skipped would be its own
    // small false statement.
    expect(isNegationShapedQuestion("I have not had coffee")).toBe(false);
  });
});

describe("the disclosure line says what DID happen, not only what did not", () => {
  test("names the cause", () => {
    expect(NEGATION_TOOLS_UNAVAILABLE_LINE).toContain("no tool access");
  });

  test("says the answer above is unverified rather than merely incomplete", () => {
    // The failure was a confident "No one." A note saying "results may be incomplete" would
    // under-describe that: the answer was not partially checked, it was not checked at all.
    expect(NEGATION_TOOLS_UNAVAILABLE_LINE).toContain("nothing above was verified");
  });

  test("routes the reader to the surfaces that DO verify", () => {
    expect(NEGATION_TOOLS_UNAVAILABLE_LINE).toContain("nimbus query");
    expect(NEGATION_TOOLS_UNAVAILABLE_LINE).toContain("nimbus people list");
  });
});
