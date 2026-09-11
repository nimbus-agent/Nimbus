import type { GapNote } from "@nimbus-dev/sdk";

import type { ChangelogRow } from "../changelog-queries.ts";

/**
 * How many entries the WINDOW held, per category — COMPLETE, never the number listed.
 *
 * The entry lists on `ChangelogBrief` are capped at `CHANGELOG_CATEGORY_CAP`; these counts are
 * not. A window holding 53 merged PRs reports `mergedPrs: 53` beside a 50-entry list, and the
 * per-category truncation is recoverable as `counts.mergedPrs - mergedPrs.length`.
 *
 * Stated explicitly because the ambiguity is invisible and survived a review once: an earlier
 * version set each count to the post-cap length, so that same window reported `50` with a single
 * cross-category "5 further entries were truncated" line from which neither true number could be
 * recovered. `synthesize.ts` hands this object to the model as authoritative findings, so a count
 * that quietly means "shown" becomes confident prose saying fifty PRs merged when fifty-three did
 * — the failure class a brief premised on "silence is never evidence" exists to prevent.
 *
 * `ChangelogBrief.indexTimedCount` is on this SAME basis (every matched row, not every listed
 * one), so the two numbers in one brief can be read against each other.
 */
export type ChangelogCounts = {
  readonly mergedPrs: number;
  readonly deployments: number;
  readonly incidentsOpened: number;
  readonly incidentsResolved: number;
};

export type ChangelogBrief = {
  readonly kind: "changelog";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: {
    /**
     * The ABSOLUTE cutoff this brief windowed on, already converted from the caller's lookback
     * DURATION by `buildChangelogBrief`. Named `sinceMs` to match every other brief's `query`
     * (`renderDecisions` computes its window heading the same way), and deliberately NOT the
     * name the builder's INPUT carries — see `BuildChangelogArgs.lookbackMs`.
     */
    readonly sinceMs: number;
    readonly nowMs: number;
    readonly service: string | null;
  };
  readonly mergedPrs: readonly ChangelogRow[];
  readonly deployments: readonly ChangelogRow[];
  readonly incidentsOpened: readonly ChangelogRow[];
  readonly incidentsResolved: readonly ChangelogRow[];
  readonly counts: ChangelogCounts;
  /**
   * Entries whose time came from `item.modified_at` rather than an event field, over every row
   * the window matched — the same PRE-CAP basis as `counts`, not the listed subset.
   */
  readonly indexTimedCount: number;
  /** Merged PRs on a forge that writes no `merged_at`, so invisible to this brief. */
  readonly nonGithubMergedPrs: number;
  /** Per-category entries dropped by the display cap, for the truncation disclosure. */
  readonly truncatedCount: number;
};
