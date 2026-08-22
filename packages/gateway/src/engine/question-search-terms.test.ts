import { describe, expect, test } from "bun:test";

import { broadestSearchTerm, questionSearchTerms } from "./question-search-terms.ts";

/**
 * F1 — the audit's opening finding. Every case here is one the audit measured on a live index.
 */
describe("questionSearchTerms (F1)", () => {
  test("the question that started the audit reduces to its identifier", () => {
    // `nimbus search "egressRowToItem"` hits; the same symbol inside a sentence returned zero
    // rows, because `ftsTitleMatchQuery` AND-joins every token and keeps punctuation, so
    // `"do?"` — a literal prefix term nothing can match — made the conjunction unsatisfiable.
    expect(questionSearchTerms("what does egressRowToItem do?")).toBe("egressRowToItem");
  });

  test("the longer phrasing does not get WORSE, which is what it used to do", () => {
    // The audit's note: the "From the local indexed context, …" phrasing was worse than the
    // short one, because it added five more AND terms. Both must now reduce to the same thing.
    expect(
      questionSearchTerms("From the local indexed context, what does egressRowToItem do?"),
    ).toBe("egressRowToItem");
  });

  test("trailing punctuation never reaches FTS", () => {
    const terms = questionSearchTerms("what about deployments, incidents; and rollbacks?") ?? "";
    expect(terms).not.toContain("?");
    expect(terms).not.toContain(",");
    expect(terms).not.toContain(";");
  });

  test("interior punctuation is kept, because it is part of the name", () => {
    // `a/b/c.ts` and `foo_bar` are single terms. Stripping their separators would search for
    // something the user did not name.
    expect(questionSearchTerms("who owns packages/gateway/src/index/item-store.ts?")).toBe(
      "packages/gateway/src/index/item-store.ts",
    );
  });

  test("quotes are dropped — the audit's Fargate question quoted the term", () => {
    expect(questionSearchTerms('list my "RequiemNexusFargate" log groups')).toContain(
      "RequiemNexusFargate",
    );
    expect(questionSearchTerms('list my "RequiemNexusFargate" log groups') ?? "").not.toContain(
      '"',
    );
  });

  test("a question with no identifier keeps its content words, not all its words", () => {
    const terms = questionSearchTerms("what changed in the billing service last week?") ?? "";
    expect(terms).not.toContain("what");
    expect(terms).not.toContain("the");
    expect(terms).toContain("billing");
  });

  test("terms are capped, because each extra one can only narrow an AND join", () => {
    const terms =
      questionSearchTerms("billing service retry backoff timeout jitter scheduler queue") ?? "";
    expect(terms.split(" ").length).toBeLessThanOrEqual(4);
  });

  test("repeated words are not searched twice", () => {
    expect(questionSearchTerms("billing billing BILLING")).toBe("billing");
  });

  test("an all-stopword question yields undefined, never everything", () => {
    // This is the case that matters most. `undefined` must mean "no context" — the old code
    // treated an empty search as a cue to fetch arbitrary recent items and present them under
    // an authoritative "Indexed Nimbus context:" header.
    expect(questionSearchTerms("what is it?")).toBeUndefined();
    expect(questionSearchTerms("   ")).toBeUndefined();
    expect(questionSearchTerms("")).toBeUndefined();
  });

  test.each([
    ["egressRowToItem", "camelCase"],
    ["pr_changed_file", "snake_case"],
    ["packages/gateway", "a path"],
    ["vec_items_1536", "digits"],
    ["RequiemNexusFargateServiceTaskDef", "a long generated name"],
  ])("%s is treated as an identifier (%s)", (token) => {
    expect(questionSearchTerms(`what is ${token}?`)).toBe(token);
  });

  test("an ordinary short word is NOT mistaken for an identifier", () => {
    // The identifier heuristic decides whether the surrounding English is dropped, so a false
    // positive here silently discards the rest of the question.
    const terms = questionSearchTerms("what changed in billing last week?") ?? "";
    expect(terms.split(" ").length).toBeGreaterThan(1);
  });
});

describe("broadestSearchTerm (F1 — relaxing an over-strict AND join)", () => {
  test("picks the longest term as the most distinctive one", () => {
    expect(broadestSearchTerm("smoke test billing")).toBe("billing");
  });

  test("a single term has nothing to widen to", () => {
    // Important that this is `undefined` and not the term itself: the caller uses it to decide
    // whether a SECOND query is worth running, and re-running the identical query would be a
    // wasted round trip that changes nothing.
    expect(broadestSearchTerm("egressRowToItem")).toBeUndefined();
    expect(broadestSearchTerm("")).toBeUndefined();
  });

  test("ties keep the first, so the result is deterministic", () => {
    expect(broadestSearchTerm("smoke issue")).toBe("smoke");
  });
});
