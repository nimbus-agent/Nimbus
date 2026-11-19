import type { GapNote } from "@nimbus-dev/sdk";

/**
 * The `pr_prereview` brief (Phase 10 "Automated PR pre-review"). `prreview/prreview-build.ts` builds it from
 * the local index with no model and no write; `prreview-render.ts` renders it deterministically. It is a brief
 * KIND for the I31 machinery (reserved `## Gaps`), not an `agents/` emitter: `ipc/prreview-rpc.ts` answers it
 * (static D22(d)). Types only.
 */

/** One past PR, as shown beside a finding or a review note. */
export type PrereviewPrRef = {
  readonly itemId: string;
  readonly title: string;
  readonly url: string | null;
  /** `merged_at` of the PR, epoch ms, or null when the index does not hold it. */
  readonly mergedAtMs: number | null;
};

/** "In {count} of {cohort} merged PRs that changed `{area}/`, `{companion}` also changed." */
export type PrereviewCoChange = {
  readonly area: string;
  readonly companion: string;
  readonly companionKind: "file" | "directory";
  readonly count: number;
  readonly cohort: number;
  readonly examples: readonly PrereviewPrRef[];
};

export type PrereviewReviewNote = {
  readonly pr: PrereviewPrRef;
  /** The review state as indexed, upper-cased (`CHANGES_REQUESTED` or `COMMENTED`). */
  readonly state: string;
  readonly reviewedAtMs: number;
  /** The review body; the renderer caps and hardens it. */
  readonly body: string;
};

export type PrereviewTerm = { readonly term: string; readonly reviews: number };

export type PrereviewSize = {
  readonly total: number;
  readonly cohortMedian: number;
  /** Share of comparable PRs strictly smaller than this one, 0 to 100, rounded down. */
  readonly percentile: number;
  readonly comparable: number;
};

export type PrereviewTarget = {
  readonly itemId: string;
  readonly service: string;
  readonly repo: string;
  readonly number: number | null;
  readonly title: string;
  readonly url: string | null;
  readonly state: string | null;
  /** Touched paths as indexed; empty when no file list is indexed. */
  readonly files: readonly string[];
  /** True when a `pr_files_state` coverage row exists. */
  readonly filesCovered: boolean;
  readonly filesTruncated: boolean;
  readonly apiFileCount: number | null;
};

export type PrereviewCounts = {
  readonly historyUsed: number;
  readonly historyNoCoverage: number;
  readonly historyTruncated: number;
  readonly areasTotal: number;
  readonly areasCut: number;
  readonly areasThinHistory: number;
  readonly findingsCut: number;
  readonly reviewsMatched: number;
};

export type PrereviewBrief = {
  readonly kind: "pr_prereview";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly target: PrereviewTarget;
  readonly coChanges: readonly PrereviewCoChange[];
  /** null when the service indexes no reviews (anything but GitHub). */
  readonly reviewNotes: readonly PrereviewReviewNote[] | null;
  readonly reviewTerms: readonly PrereviewTerm[];
  readonly size: PrereviewSize | null;
  readonly counts: PrereviewCounts;
};
