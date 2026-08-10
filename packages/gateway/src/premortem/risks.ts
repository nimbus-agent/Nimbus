import type { CohortCandidate } from "./cohort.ts";

export type RiskKind =
  | "cycle_time"
  | "size_overrun"
  | "review_drag"
  | "incident_coupling"
  | "abandonment";

export type Risk = {
  kind: RiskKind;
  /** Rendered sentence for the brief. */
  summary: string;
  /** Null when the cohort cannot support this risk — the brief prints a named gap. */
  value: number | null;
  /** True when the figure is an expectation about a young epic, not a comparison. */
  expectationOnly: boolean;
};

const DAY_MS = 86_400_000;

/** Median of a numeric array, over a sorted COPY — never mutates the input. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted.at(mid - 1) ?? 0;
    const upper = sorted.at(mid) ?? 0;
    return (lower + upper) / 2;
  }
  return sorted.at(mid) ?? 0;
}

function computeCycleTime(input: {
  cohort: readonly CohortCandidate[];
  targetCreatedAtMs: number;
  nowMs: number;
}): Risk {
  const ageMs = input.nowMs - input.targetCreatedAtMs;
  const expectationOnly = ageMs < DAY_MS;

  const cycleTimesMs = input.cohort
    .filter((c) => c.createdAtMs !== null)
    .map((c) => c.resolvedAtMs - (c.createdAtMs as number));
  const medianMs = median(cycleTimesMs);

  if (medianMs === null) {
    return {
      kind: "cycle_time",
      summary: "No comparable epics recorded a creation date, so cycle time cannot be estimated.",
      value: null,
      expectationOnly,
    };
  }

  const medianDays = medianMs / DAY_MS;
  const medianDaysRounded = Math.round(medianDays * 10) / 10;

  if (expectationOnly) {
    return {
      kind: "cycle_time",
      summary: `Across ${cycleTimesMs.length} comparable epics, the median time to close was ${medianDaysRounded} days.`,
      value: medianMs,
      expectationOnly: true,
    };
  }

  const elapsedDays = Math.round((ageMs / DAY_MS) * 10) / 10;
  return {
    kind: "cycle_time",
    summary: `Across ${cycleTimesMs.length} comparable epics, the median time to close was ${medianDaysRounded} days, vs ${elapsedDays} days elapsed so far.`,
    value: medianMs,
    expectationOnly: false,
  };
}

function computeSizeOverrun(input: {
  cohort: readonly CohortCandidate[];
  targetChildCount: number;
}): Risk {
  const childCounts = input.cohort.map((c) => c.childCount);
  const medianChildren = median(childCounts);

  if (medianChildren === null) {
    return {
      kind: "size_overrun",
      summary: "No comparable epics were found, so expected scope cannot be estimated.",
      value: null,
      expectationOnly: false,
    };
  }

  if (medianChildren === 0) {
    return {
      kind: "size_overrun",
      summary: `Across ${childCounts.length} comparable epics, every one recorded zero child items, so scope comparison cannot be measured.`,
      value: null,
      expectationOnly: false,
    };
  }

  const ratio = input.targetChildCount / medianChildren;
  const ratioRounded = Math.round(ratio * 100) / 100;
  return {
    kind: "size_overrun",
    summary: `Across ${childCounts.length} comparable epics, the median child-item count was ${medianChildren}, vs ${input.targetChildCount} for this epic.`,
    value: ratioRounded,
    expectationOnly: false,
  };
}

function computeReviewDrag(input: {
  reviewDragMedianMs: number | null;
  repoReviewMedianMs: number | null;
  /**
   * True when the cohort DOES have linked pull requests but none carry an
   * opened/created timestamp — a fact only the caller (which runs the
   * database queries) can know, since this file is deliberately
   * database-free. Picks between two distinct unmeasurable causes: "no PRs
   * at all" (the pre-existing message) vs. "PRs exist, but this connector
   * doesn't index when they opened" — stating the wrong one names a cause
   * that isn't true.
   */
  cohortHasPrsWithoutOpenTimestamp: boolean;
}): Risk {
  if (input.reviewDragMedianMs === null || input.repoReviewMedianMs === null) {
    const summary = input.cohortHasPrsWithoutOpenTimestamp
      ? "Review drag cannot be measured: this cohort has linked pull requests, but no " +
        "connector indexes a pull request's opened timestamp, only its merge time."
      : "No pull requests were found for this cohort, so review drag cannot be measured.";
    return {
      kind: "review_drag",
      summary,
      value: null,
      expectationOnly: false,
    };
  }

  const cohortHours = Math.round((input.reviewDragMedianMs / 3_600_000) * 10) / 10;
  const repoHours = Math.round((input.repoReviewMedianMs / 3_600_000) * 10) / 10;
  const delta = input.reviewDragMedianMs - input.repoReviewMedianMs;
  return {
    kind: "review_drag",
    summary: `This cohort's pull requests took a median ${cohortHours} hours to merge, vs ${repoHours} hours across the repo over the same window.`,
    value: delta,
    expectationOnly: false,
  };
}

function computeIncidentCoupling(input: {
  cohort: readonly CohortCandidate[];
  /**
   * Null means "unmeasurable", never a fabricated zero: the caller
   * translates each cohort service (a PR repo, e.g. `acme/billing-api`)
   * into a DORA `[ci.service.<id>]` config id before matching a deployment's
   * `metadata.affectedService` — those are two different vocabularies, and
   * when NOTHING translates, a literal `0` would read as "measured, and
   * zero incidents correlated" rather than "no deployment-service mapping
   * exists for these repos at all".
   */
  incidentCoupledCount: number | null;
}): Risk {
  if (input.cohort.length === 0) {
    return {
      kind: "incident_coupling",
      summary: "No comparable epics were found, so incident coupling cannot be measured.",
      value: null,
      expectationOnly: false,
    };
  }

  if (input.incidentCoupledCount === null) {
    return {
      kind: "incident_coupling",
      summary:
        "Incident coupling cannot be measured: no deployment-service mapping " +
        "(`[metrics.dora.<id>]` / `[ci.service.<id>]`) is configured for these repos, so a " +
        "deploy cannot be matched to a service in this cohort.",
      value: null,
      expectationOnly: false,
    };
  }

  const rate = input.incidentCoupledCount / input.cohort.length;
  const ratePct = Math.round(rate * 1000) / 10;
  return {
    kind: "incident_coupling",
    summary: `${input.incidentCoupledCount} of ${input.cohort.length} comparable epics (${ratePct}%) had incidents correlated with deploys of these services during each epic's window.`,
    value: rate,
    expectationOnly: false,
  };
}

function computeAbandonment(input: {
  cohort: readonly CohortCandidate[];
  cohortIsMixedTracker: boolean;
}): Risk {
  if (input.cohortIsMixedTracker) {
    return {
      kind: "abandonment",
      summary:
        "Abandonment rate cannot be measured on this cohort: Jira does not distinguish canceled work from done work in the synced status, so a blended rate across trackers would not be comparable.",
      value: null,
      expectationOnly: false,
    };
  }

  if (input.cohort.length === 0) {
    return {
      kind: "abandonment",
      summary: "No comparable epics were found, so abandonment rate cannot be measured.",
      value: null,
      expectationOnly: false,
    };
  }

  const canceledCount = input.cohort.filter((c) => c.statusCategory === "canceled").length;
  const rate = canceledCount / input.cohort.length;
  const ratePct = Math.round(rate * 1000) / 10;
  return {
    kind: "abandonment",
    summary: `${canceledCount} of ${input.cohort.length} comparable epics (${ratePct}%) were abandoned rather than completed.`,
    value: rate,
    expectationOnly: false,
  };
}

/**
 * The five structural risk calculators. Pure functions over a cohort and a
 * handful of caller-supplied figures — no database access, so this file
 * stays testable over fixtures (Task 4 owns the three queries that produce
 * `reviewDragMedianMs`, `repoReviewMedianMs` and `incidentCoupledCount`).
 *
 * A risk that cannot be measured returns `value: null`, never 0 — the brief
 * renders a named gap rather than an honest-looking zero.
 */
export function computeRisks(input: {
  cohort: readonly CohortCandidate[];
  targetChildCount: number;
  targetCreatedAtMs: number;
  nowMs: number;
  reviewDragMedianMs: number | null;
  repoReviewMedianMs: number | null;
  cohortHasPrsWithoutOpenTimestamp: boolean;
  incidentCoupledCount: number | null;
  cohortIsMixedTracker: boolean;
}): Risk[] {
  return [
    computeCycleTime({
      cohort: input.cohort,
      targetCreatedAtMs: input.targetCreatedAtMs,
      nowMs: input.nowMs,
    }),
    computeSizeOverrun({ cohort: input.cohort, targetChildCount: input.targetChildCount }),
    computeReviewDrag({
      reviewDragMedianMs: input.reviewDragMedianMs,
      repoReviewMedianMs: input.repoReviewMedianMs,
      cohortHasPrsWithoutOpenTimestamp: input.cohortHasPrsWithoutOpenTimestamp,
    }),
    computeIncidentCoupling({
      cohort: input.cohort,
      incidentCoupledCount: input.incidentCoupledCount,
    }),
    computeAbandonment({ cohort: input.cohort, cohortIsMixedTracker: input.cohortIsMixedTracker }),
  ];
}
