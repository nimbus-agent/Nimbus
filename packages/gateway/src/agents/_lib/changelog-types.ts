import type { GapNote } from "@nimbus-dev/sdk";

import type { ChangelogRow } from "../changelog-queries.ts";

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
  /** Entries whose time came from `item.modified_at` rather than an event field. */
  readonly indexTimedCount: number;
  /** Merged PRs on a forge that writes no `merged_at`, so invisible to this brief. */
  readonly nonGithubMergedPrs: number;
  /** Per-category entries dropped by the display cap, for the truncation disclosure. */
  readonly truncatedCount: number;
};
