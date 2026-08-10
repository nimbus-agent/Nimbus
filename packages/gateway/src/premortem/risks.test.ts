import { describe, expect, test } from "bun:test";
import type { CohortCandidate } from "./cohort.ts";
import { computeRisks } from "./risks.ts";

const DAY = 86_400_000;

function candidate(over: Partial<CohortCandidate> = {}): CohortCandidate {
  return {
    itemId: "jira:E-1",
    key: "E-1",
    title: "epic",
    services: ["billing"],
    createdAtMs: 0,
    resolvedAtMs: 10 * DAY,
    statusCategory: "done",
    childCount: 4,
    score: 1,
    ...over,
  };
}

const BASE = {
  targetChildCount: 4,
  targetCreatedAtMs: 0,
  nowMs: 30 * DAY,
  reviewDragMedianMs: null,
  repoReviewMedianMs: null,
  cohortHasPrsMissingTimingData: false,
  incidentCoupling: { coupled: 0, measured: 1 },
  cohortIsMixedTracker: false,
};

describe("computeRisks", () => {
  test("cycle time on a YOUNG epic is an expectation, not a comparison", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ resolvedAtMs: 24 * DAY })],
      targetCreatedAtMs: 30 * DAY - 3600_000, // one hour old
    });
    const cycle = risks.find((r) => r.kind === "cycle_time");
    expect(cycle?.expectationOnly).toBe(true);
    expect(cycle?.summary).not.toContain("vs 0");
    // Pin the exact rendered sentence — catches both a reintroduced "vs N days"
    // clause on the young path AND a duplicated-phrase regression ("comparable
    // epics, comparable epics").
    expect(cycle?.summary).toBe("Across 1 comparable epics, the median time to close was 24 days.");
  });

  test("a future-dated epic (clock skew) is treated as YOUNG, never compared to negative elapsed time", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ resolvedAtMs: 24 * DAY })],
      targetCreatedAtMs: 40 * DAY, // ahead of nowMs
      nowMs: 30 * DAY,
    });
    expect(risks.find((r) => r.kind === "cycle_time")?.expectationOnly).toBe(true);
  });

  test("cycle time boundary: exactly one day old still compares (only strictly under a day is an expectation)", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ resolvedAtMs: 24 * DAY })],
      targetCreatedAtMs: 30 * DAY - DAY, // exactly one day old at nowMs
      nowMs: 30 * DAY,
    });
    expect(risks.find((r) => r.kind === "cycle_time")?.expectationOnly).toBe(false);
  });

  test("cycle time on an OLD epic compares against elapsed time", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ resolvedAtMs: 24 * DAY })],
      targetCreatedAtMs: 0,
      nowMs: 30 * DAY,
    });
    const cycle = risks.find((r) => r.kind === "cycle_time");
    expect(cycle?.expectationOnly).toBe(false);
    expect(cycle?.summary).toBe(
      "Across 1 comparable epics, the median time to close was 24 days, vs 30 days elapsed so far.",
    );
  });

  test("cycle time median is computed over non-null createdAtMs members only", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [
        // Valid member: cycle time is 4 days.
        candidate({ createdAtMs: 0, resolvedAtMs: 4 * DAY }),
        // No creation date recorded — must be EXCLUDED from the median, not
        // coerced into a bogus cycle time via `resolvedAtMs - null` (which
        // JS arithmetic silently evaluates as `resolvedAtMs - 0`).
        candidate({ createdAtMs: null, resolvedAtMs: 1 * DAY }),
      ],
      targetCreatedAtMs: 0,
      nowMs: 30 * DAY,
    });
    const cycle = risks.find((r) => r.kind === "cycle_time");
    // If the null member were included, the median over [4*DAY, 1*DAY] would
    // be 2.5*DAY instead of the single valid member's 4*DAY.
    expect(cycle?.value).toBe(4 * DAY);
  });

  test("an empty cohort yields null values, never zero", () => {
    const risks = computeRisks({ ...BASE, cohort: [] });
    for (const r of risks) {
      expect(r.value).toBeNull();
    }
  });

  test("size overrun is null, not zero, when every comparable epic recorded zero child items", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ childCount: 0 }), candidate({ childCount: 0 })],
    });
    const so = risks.find((r) => r.kind === "size_overrun");
    expect(so?.value).toBeNull();
    expect(so?.summary.toLowerCase()).toContain("zero");
  });

  test("abandonment is suppressed with a stated reason on a mixed-tracker cohort", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ statusCategory: "canceled" })],
      cohortIsMixedTracker: true,
    });
    const ab = risks.find((r) => r.kind === "abandonment");
    expect(ab?.value).toBeNull();
    expect(ab?.summary.toLowerCase()).toContain("jira");
  });

  test("incident coupling never claims causation", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate()],
      incidentCoupling: { coupled: 1, measured: 1 },
    });
    const ic = risks.find((r) => r.kind === "incident_coupling");
    expect(ic?.summary).toMatch(/correlat/i);
    expect(ic?.summary).not.toMatch(/caused|because of/i);
  });

  test("incident coupling is a named gap, not a fabricated zero, when nothing translates to a deploy-service mapping", () => {
    const risks = computeRisks({ ...BASE, cohort: [candidate()], incidentCoupling: null });
    const ic = risks.find((r) => r.kind === "incident_coupling");
    expect(ic?.value).toBeNull();
    expect(ic?.summary).not.toMatch(/^0 of/);
    expect(ic?.summary.toLowerCase()).toContain("no deployment-service mapping");
  });

  test("incident coupling reports a real measured zero once at least one service resolves", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate()],
      incidentCoupling: { coupled: 0, measured: 1 },
    });
    const ic = risks.find((r) => r.kind === "incident_coupling");
    expect(ic?.value).toBe(0);
    expect(ic?.summary).toMatch(/^0 of 1/);
  });

  // Important 2 (round 2 review): the rate must be denominated on the
  // MEASURED population, not the full cohort — a cohort member that could
  // never be queried (no createdAtMs, or no resolvable service) must not
  // count toward "how many epics we compared this against".
  test("incident coupling denominates on the MEASURED count, not the full cohort, when some members couldn't be checked", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ key: "E-1" }), candidate({ key: "E-2" })],
      // Only 1 of the 2 comparable epics was actually measured.
      incidentCoupling: { coupled: 1, measured: 1 },
    });
    const ic = risks.find((r) => r.kind === "incident_coupling");
    // A wrong "denominate on cohort.length" implementation would report
    // value 0.5 and "1 of 2 comparable epics (50%)" as the RATE clause here
    // instead — the skipped-count note legitimately mentions "1 of 2" too
    // (in a different sentence), so this checks the rate clause specifically.
    expect(ic?.value).toBe(1);
    expect(ic?.summary).toContain("1 of 1 comparable epics (100%)");
    expect(ic?.summary).not.toContain("1 of 2 comparable epics (50%)");
    expect(ic?.summary.toLowerCase()).toContain("could not be checked");
  });

  test("incident coupling states no skipped-epic note when every comparable epic was measured", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate()],
      incidentCoupling: { coupled: 0, measured: 1 },
    });
    const ic = risks.find((r) => r.kind === "incident_coupling");
    expect(ic?.summary.toLowerCase()).not.toContain("could not be checked");
  });

  test("review drag names the real cause when the cohort has PRs but the index is missing timing data", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate()],
      cohortHasPrsMissingTimingData: true,
    });
    const rd = risks.find((r) => r.kind === "review_drag");
    expect(rd?.value).toBeNull();
    expect(rd?.summary).not.toContain("No pull requests were found");
    expect(rd?.summary.toLowerCase()).toContain("does not record both an opened and a merged");
  });

  // Important 1 (round 2 review): the message must not assert WHICH single
  // timestamp is missing — an earlier version named only "opened", which is
  // false the moment a PR HAS an opened timestamp but no merged one (an
  // open PR — the common case once a connector indexes PR-open events).
  test("review drag's missing-timing-data message does not claim only the opened timestamp is absent", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate()],
      cohortHasPrsMissingTimingData: true,
    });
    const rd = risks.find((r) => r.kind === "review_drag");
    expect(rd?.summary).not.toMatch(/no connector indexes a pull request's opened timestamp/i);
    expect(rd?.summary).not.toMatch(/only its merge time/i);
  });

  test("review drag keeps the 'no pull requests' message when the cohort truly has none", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate()],
      cohortHasPrsMissingTimingData: false,
    });
    const rd = risks.find((r) => r.kind === "review_drag");
    expect(rd?.value).toBeNull();
    expect(rd?.summary).toContain("No pull requests were found for this cohort");
  });

  test("all five risks are always returned, in a stable order", () => {
    const risks = computeRisks({ ...BASE, cohort: [candidate()] });
    expect(risks.map((r) => r.kind)).toEqual([
      "cycle_time",
      "size_overrun",
      "review_drag",
      "incident_coupling",
      "abandonment",
    ]);
  });
});
