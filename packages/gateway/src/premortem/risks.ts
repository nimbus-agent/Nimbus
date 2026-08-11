import type { CohortCandidate } from "./cohort.ts";
import { median } from "./median.ts";

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

/**
 * `targetCreatedAtMs === null` means the target epic's own sync never recorded
 * a creation date — NOT that it was created just now. The distinction is the
 * whole point: an earlier version defaulted the missing value to `nowMs`,
 * which produced `ageMs ≈ 0`, flipped `expectationOnly` on, and made the brief
 * read as "this epic is brand new" to a reader whose epic might be a year old.
 * The cohort median is still perfectly measurable in that case — only the
 * comparison against elapsed time is not — so the figure is still reported,
 * with the real cause named in the sentence.
 */
function computeCycleTime(input: {
  cohort: readonly CohortCandidate[];
  targetCreatedAtMs: number | null;
  nowMs: number;
}): Risk {
  const ageMs = input.targetCreatedAtMs === null ? null : input.nowMs - input.targetCreatedAtMs;
  const expectationOnly = ageMs === null || ageMs < DAY_MS;

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

  if (ageMs === null) {
    return {
      kind: "cycle_time",
      summary:
        `Across ${cycleTimesMs.length} comparable epics, the median time to close was ` +
        `${medianDaysRounded} days. This epic has no recorded creation date in the index, so ` +
        "elapsed time could not be compared against it — this is a missing date, not a young epic.",
      value: medianMs,
      expectationOnly: true,
    };
  }

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
   * True when the cohort DOES have linked pull requests but none carries
   * BOTH an opened and a merged timestamp — a fact only the caller (which
   * runs the database queries) can know, since this file is deliberately
   * database-free. Picks between two distinct unmeasurable causes: "no PRs
   * at all" (the pre-existing message) vs. "PRs exist, but the index is
   * missing one of the two timestamps needed to measure drag on them".
   *
   * Deliberately NOT split into "missing opened" vs. "missing merged": an
   * earlier version named only the opened timestamp as missing, which is
   * false the moment a PR carries an opened timestamp but no merged one (an
   * open PR) — the common case once a connector starts indexing PR-open
   * events, which is exactly the moment this discriminator starts firing in
   * practice. Naming what was actually checked (both fields, together)
   * stays true regardless of which one (or both) is absent.
   */
  cohortHasPrsMissingTimingData: boolean;
}): Risk {
  if (input.reviewDragMedianMs === null || input.repoReviewMedianMs === null) {
    const summary = input.cohortHasPrsMissingTimingData
      ? "Review drag cannot be measured: this cohort has linked pull requests, but the " +
        "index does not record both an opened and a merged timestamp for these pull requests."
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
   * when NOTHING resolves — including when a resolvable member could not be
   * windowed (no `createdAtMs`), leaving zero members actually queried — a
   * literal `0` would read as "measured, and zero incidents correlated"
   * rather than "nothing in this cohort could be checked at all".
   *
   * `measured` is the denominator: only members that were ACTUALLY queried
   * (a resolvable service AND a usable window). `input.cohort.length` is the
   * full cohort and must never be used as the denominator here — a rate
   * stated over epics that were never measured is a different defect from
   * the fabricated-zero one (Critical 1), but the same class: presenting a
   * number as measured fact when it isn't.
   */
  incidentCoupling: { coupled: number; measured: number } | null;
}): Risk {
  if (input.cohort.length === 0) {
    return {
      kind: "incident_coupling",
      summary: "No comparable epics were found, so incident coupling cannot be measured.",
      value: null,
      expectationOnly: false,
    };
  }

  if (input.incidentCoupling === null) {
    return {
      kind: "incident_coupling",
      // Hedged across the two possible causes rather than asserting one:
      // `measured` reaches 0 either because no cohort repo translates to a
      // configured DORA service id, OR because every repo that DOES
      // translate belongs to a comparable epic with no recorded creation
      // date to check a window against — the caller cannot tell which
      // without re-deriving state this function deliberately stays
      // database-free of, so naming only one would risk stating a false
      // cause (the exact defect this discriminator exists to avoid).
      summary:
        "Incident coupling cannot be measured for this cohort: either no deployment-service " +
        "mapping (`[metrics.dora.<id>]` / `[ci.service.<id>]`) is configured for these repos, " +
        "or every epic whose service does map has no recorded creation date to check a window " +
        "against.",
      value: null,
      expectationOnly: false,
    };
  }

  const { coupled, measured } = input.incidentCoupling;
  const rate = coupled / measured;
  const ratePct = Math.round(rate * 1000) / 10;
  const skipped = input.cohort.length - measured;
  const skippedNote =
    skipped > 0
      ? ` (${skipped} of ${input.cohort.length} comparable epic(s) could not be checked — no recorded creation date, or no resolvable service mapping)`
      : "";
  return {
    kind: "incident_coupling",
    summary:
      `${coupled} of ${measured} comparable epics (${ratePct}%) had incidents correlated ` +
      `with deploys of these services during each epic's window${skippedNote}.`,
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
  /** `null` when the index recorded no creation date — never substituted with `nowMs`. */
  targetCreatedAtMs: number | null;
  nowMs: number;
  reviewDragMedianMs: number | null;
  repoReviewMedianMs: number | null;
  cohortHasPrsMissingTimingData: boolean;
  incidentCoupling: { coupled: number; measured: number } | null;
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
      cohortHasPrsMissingTimingData: input.cohortHasPrsMissingTimingData,
    }),
    computeIncidentCoupling({
      cohort: input.cohort,
      incidentCoupling: input.incidentCoupling,
    }),
    computeAbandonment({ cohort: input.cohort, cohortIsMixedTracker: input.cohortIsMixedTracker }),
  ];
}
