import { describe, expect, test } from "bun:test";
import type { Disclosure } from "./brief-disclosures.ts";
import {
  changelogDisclosures,
  negotiateOwnershipDisclosures,
  negotiateWindowDisclosure,
  oncallDisclosures,
  standupDisclosures,
} from "./brief-disclosures.ts";
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

/**
 * The changelog time-basis entry, which exists only when something WAS index-timed — the same
 * condition its renderer applies. Indexed by position because that is how `changelogDisclosures`
 * orders them: the unconditional meaning-of-the-numbers line, then this one.
 */
function changelogTimeBasis(): Disclosure {
  const d = changelogDisclosures({ indexTimedCount: 3, truncatedCount: 0 })[1];
  if (d === undefined)
    throw new Error("changelog time-basis disclosure missing at indexTimedCount > 0");
  return d;
}

/**
 * The standup time-basis entry, which exists only when something CAN be misplaced — the same
 * condition its renderer applies. Indexed by position because that is how `standupDisclosures`
 * orders them: the unconditional meaning-of-the-numbers line, then this one.
 */
function standupTimeBasis(): Disclosure {
  const d = standupDisclosures({ approximateCount: 3, truncatedCount: 0 })[1];
  if (d === undefined)
    throw new Error("standup time-basis disclosure missing at approximateCount > 0");
  return d;
}

const TWO_SENTENCE_ENTRIES: ReadonlyArray<readonly [string, Disclosure]> = [
  ["negotiate window", negotiateWindowDisclosure(WINDOW_MS, GENERATED_AT)],
  ["negotiate ownership accountability", negotiateOwnershipDisclosures(ownership()).accountability],
  ["changelog time basis", changelogTimeBasis()],
  ["standup time basis", standupTimeBasis()],
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

  test("changelog's preamble anchors are not satisfiable by a sibling disclosure's line", () => {
    // All three changelog disclosures share ONE scope (the preamble), so `contractViolations`
    // searches the same text for every anchor. An anchor that also occurs in a sibling's line
    // would let a rewrite drop its own disclosure entirely and still pass — an honesty guard
    // failing in the false-negative direction, which is the one that matters.
    const all = changelogDisclosures({ indexTimedCount: 3, truncatedCount: 4 });
    expect(all).toHaveLength(3);
    for (const [i, d] of all.entries()) {
      const siblings = all.filter((_, j) => j !== i).map((s) => s.line);
      for (const anchor of d.anchors) {
        expect(d.line).toContain(anchor);
        for (const sibling of siblings) expect(sibling).not.toContain(anchor);
      }
    }
  });

  test("changelog's anchors stay in the 2-7 word band its neighbours use", () => {
    // A near-verbatim clause is a rewrite BAN, not an anchor: it makes ordinary paraphrase a
    // contract violation, so synthesis fails closed on every run and the feature ships inert.
    for (const d of changelogDisclosures({ indexTimedCount: 3, truncatedCount: 4 })) {
      for (const anchor of d.anchors) {
        const words = anchor.trim().split(/\s+/).length;
        expect(words).toBeGreaterThanOrEqual(2);
        expect(words).toBeLessThanOrEqual(7);
      }
    }
  });

  test("standup's preamble anchors are not satisfiable by a sibling disclosure's line", () => {
    // All three standup disclosures share ONE scope (the preamble), so `contractViolations`
    // searches the same text for every anchor. An anchor that also occurs in a sibling's line
    // would let a rewrite drop its own disclosure entirely and still pass — an honesty guard
    // failing in the false-negative direction, which is the one that matters.
    const all = standupDisclosures({ approximateCount: 3, truncatedCount: 4 });
    expect(all).toHaveLength(3);
    for (const [i, d] of all.entries()) {
      const siblings = all.filter((_, j) => j !== i).map((sib) => sib.line);
      for (const anchor of d.anchors) {
        expect(d.line).toContain(anchor);
        for (const sibling of siblings) expect(sibling).not.toContain(anchor);
      }
    }
  });

  test("standup's anchors stay in the 2-7 word band its neighbours use", () => {
    // A near-verbatim clause is a rewrite BAN, not an anchor: it makes ordinary paraphrase a
    // contract violation, so synthesis fails closed on every run and the feature ships inert.
    for (const d of standupDisclosures({ approximateCount: 3, truncatedCount: 4 })) {
      for (const anchor of d.anchors) {
        const words = anchor.trim().split(/\s+/).length;
        expect(words).toBeGreaterThanOrEqual(2);
        expect(words).toBeLessThanOrEqual(7);
      }
    }
  });

  test("the standup time-basis disclosure anchors its sync-lag sentence", () => {
    // Sentence 2 is the one that says incident response UNDER-REPORTS. A rewrite keeping only
    // sentence 1 ("placed by when the index last wrote the row") would leave the reader with the
    // mechanism and none of its consequence — the same half-drop observed on `negotiate`.
    const d = standupTimeBasis();
    expect(d.anchors.some((a) => a.includes("under-reports by sync lag"))).toBe(true);
  });

  test("standup's unconditional disclosure is emitted even on an entirely empty day", () => {
    // The conditional two drop out at zero. If the first were conditional too, a standup with no
    // activity would carry NO window bound at all — and "nothing here" would read as a claim
    // about all time rather than about the last 24 hours.
    const all = standupDisclosures({ approximateCount: 0, truncatedCount: 0 });
    expect(all).toHaveLength(1);
    expect(all[0]?.line).toContain("cover only this window");
  });

  test("the changelog time-basis disclosure anchors its sync-lag sentence", () => {
    // Sentence 2 is the one that says resolutions UNDER-REPORT. A rewrite keeping only sentence 1
    // ("timed from the index's last-touch column") would leave the reader with the mechanism and
    // none of the consequence — the exact shape F27 was opened for.
    const d = changelogTimeBasis();
    expect(d.anchors.some((a) => a.includes("under-report by sync lag"))).toBe(true);
  });
});

describe("oncall disclosure anchors", () => {
  /** Every oncall disclosure, with each conditional one switched on. */
  function allOncall(): readonly Disclosure[] {
    return oncallDisclosures({
      syncAgeMs: 7_200_000,
      syncUnknown: false,
      hasDeployment: true,
      otherActiveCount: 2,
      assigneeScoped: true,
      truncatedCount: 4,
    });
  }

  test("preamble anchors are not satisfiable by a sibling disclosure's line", () => {
    // All four oncall disclosures share ONE scope (the preamble), so `contractViolations`
    // searches the same text for every anchor. An anchor that also occurs in a sibling's line
    // would let a rewrite drop its own disclosure entirely and still pass — the false-negative
    // direction, which is the one that matters for an honesty guard.
    const all = allOncall();
    expect(all).toHaveLength(4);
    for (const [i, d] of all.entries()) {
      const siblings = all.filter((_, j) => j !== i).map((s) => s.line);
      for (const anchor of d.anchors) {
        expect(d.line).toContain(anchor);
        for (const sibling of siblings) expect(sibling).not.toContain(anchor);
      }
    }
  });

  test("anchors stay in the 2-7 word band its neighbours use", () => {
    // A near-verbatim clause is a rewrite BAN, not an anchor: it makes ordinary paraphrase a
    // contract violation, so synthesis fails closed on every run and the feature ships inert.
    for (const d of allOncall()) {
      for (const anchor of d.anchors) {
        const words = anchor.trim().split(/\s+/).length;
        expect(words).toBeGreaterThanOrEqual(2);
        expect(words).toBeLessThanOrEqual(7);
      }
    }
  });

  test("the sync-freshness disclosure is emitted unconditionally, on every shape", () => {
    // THE load-bearing one. It qualifies which INCIDENT was selected rather than a count, so a
    // brief that dropped it would present a possibly-closed incident as live with nothing on the
    // page saying so. Emitted even when the sync is seconds old, because a line the reader only
    // ever sees when something is wrong gives them no way to calibrate what it means.
    for (const opts of [
      { syncAgeMs: 0, syncUnknown: false },
      { syncAgeMs: 86_400_000, syncUnknown: false },
      { syncAgeMs: null, syncUnknown: true },
    ]) {
      const all = oncallDisclosures({
        ...opts,
        hasDeployment: false,
        otherActiveCount: 0,
        assigneeScoped: true,
        truncatedCount: 0,
      });
      expect(all).toHaveLength(1);
      expect(all[0]?.anchors).toContain("may have been closed");
    }
  });

  test("the sync-freshness disclosure anchors BOTH its sentences", () => {
    // Sentence 1 names the SOURCE of the status; sentence 2 the consequence. A single anchor
    // drawn from sentence 1 would let a rewrite keep the fact and drop the caution — exactly the
    // F27 failure observed on `negotiate`.
    const d = allOncall()[0];
    if (d === undefined) throw new Error("sync-freshness disclosure missing");
    expect(d.anchors).toContain("from the last PagerDuty sync");
    expect(d.anchors).toContain("may have been closed");
    expect(d.anchors.length).toBeGreaterThanOrEqual(sentenceCount(d.line));
  });

  test("the correlation disclosure appears only when there is a deployment to qualify", () => {
    // With no deploy found there is no causal claim on the page to walk back, and an
    // inapplicable caveat is how a reader learns to skip the ones that do apply.
    const withDeploy = oncallDisclosures({
      syncAgeMs: 0,
      syncUnknown: false,
      hasDeployment: true,
      otherActiveCount: 0,
      assigneeScoped: true,
      truncatedCount: 0,
    });
    const without = oncallDisclosures({
      syncAgeMs: 0,
      syncUnknown: false,
      hasDeployment: false,
      otherActiveCount: 0,
      assigneeScoped: true,
      truncatedCount: 0,
    });
    expect(withDeploy.some((d) => d.anchors.includes("timing alone"))).toBe(true);
    expect(without.some((d) => d.anchors.includes("timing alone"))).toBe(false);
  });

  test("the correlation disclosure anchors its it-is-not-a-cause sentence", () => {
    // Named explicitly rather than left to the count: this is the sentence standing between a
    // timestamp comparison and a reader reading it as a root cause.
    const d = allOncall().find((x) => x.anchors.includes("timing alone"));
    if (d === undefined) throw new Error("correlation disclosure missing");
    expect(d.anchors).toContain("a place to look");
  });

  test("every anchor actually occurs in its own line", () => {
    // An anchor absent from the text it guards is inert — it would fail on every brief, and a
    // guard that always fails gets removed rather than fixed.
    for (const d of allOncall()) {
      for (const anchor of d.anchors) expect(d.line).toContain(anchor);
    }
  });
});
