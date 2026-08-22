import { describe, expect, test } from "bun:test";
import type { Disclosure } from "./brief-disclosures.ts";
import { negotiateOwnershipDisclosures, negotiateWindowDisclosure } from "./brief-disclosures.ts";
import type { NegotiateOwnership } from "./negotiate-types.ts";

/**
 * F27 — an I31 anchor guarded only the FIRST sentence of a two-sentence disclosure, and the
 * second was observed being dropped by an accepted synthesis.
 *
 * Two consecutive `nimbus negotiate` runs on an unchanged index. The discarded run kept both
 * sentences; the accepted one shipped without this:
 *
 *   "Two lanes sit outside it: decisions windows on its recorded decision date, and ownership
 *    is not windowed at all (it is an all-time snapshot)"
 *
 * That sentence is not decorative. It says two of the brief's own sections — `## Decisions` and
 * `## Ownership` — are NOT filtered by the window in the header directly above them. Without it a
 * reader applies "last 90d" to an all-time ownership snapshot, which is the exact overstatement
 * the window clause exists to prevent.
 *
 * The triple rule was satisfied — wiring, docs and test all existed. The gap was the GRANULARITY
 * of the check: one `line` carrying two independent disclosures, one `anchor` drawn from the
 * first sentence, so a rewrite keeping sentence 1 passed.
 *
 * The doc's own recorded bound is weaker than this: "a phrase check proves a fragment survived,
 * not that its sentence still means the same thing". Here the surviving fragment was not in the
 * dropped sentence at all, so no reading of "the same sentence" covers it.
 */

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const GENERATED_AT = 1_700_000_000_000;

function ownership(): NegotiateOwnership {
  return { truncated: false, paths: [] } as unknown as NegotiateOwnership;
}

/** Sentence-ish split, for prose we control: a period, a space, then a capital. */
function sentenceCount(line: string): number {
  const body = line.replaceAll(/^[-_\s]+|_+$/g, "").trim();
  const withoutTail = body.split(" · ")[0] ?? body;
  return withoutTail.split(/\.\s+(?=[A-Z])/).filter((s) => s.trim().length > 0).length;
}

const TWO_SENTENCE_ENTRIES: ReadonlyArray<readonly [string, Disclosure]> = [
  ["negotiate window", negotiateWindowDisclosure(WINDOW_MS, GENERATED_AT)],
  ["negotiate ownership accountability", negotiateOwnershipDisclosures(ownership()).accountability],
];

describe("every sentence of a disclosure is anchored (F27)", () => {
  for (const [label, disclosure] of TWO_SENTENCE_ENTRIES) {
    test(`${label}: anchor count covers sentence count`, () => {
      expect(disclosure.anchors.length).toBeGreaterThanOrEqual(sentenceCount(disclosure.line));
    });

    test(`${label}: every anchor actually occurs in its own line`, () => {
      // An anchor absent from the text it guards is inert — it would fail on every brief, and a
      // guard that always fails gets removed rather than fixed.
      for (const anchor of disclosure.anchors) {
        expect(disclosure.line).toContain(anchor);
      }
    });
  }

  test("the window disclosure anchors the lanes-outside-the-window sentence", () => {
    // Named explicitly rather than left to the count: this is the sentence that was observed
    // being dropped, and a refactor should fail loudly if it stops being guarded.
    const d = negotiateWindowDisclosure(WINDOW_MS, GENERATED_AT);
    expect(d.anchors.some((a) => a.includes("Two lanes sit outside"))).toBe(true);
  });

  test("the ownership disclosure anchors its substantive second sentence", () => {
    // Sentence 2 carries the facts: no CODEOWNERS, no on-call rotation, reviewer data not
    // factored in. Sentence 1 ("authorship-derived") was the only anchored half.
    const d = negotiateOwnershipDisclosures(ownership()).accountability;
    expect(d.anchors.some((a) => a.includes("CODEOWNERS"))).toBe(true);
  });
});
