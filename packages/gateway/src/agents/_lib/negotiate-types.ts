import type { GapNote } from "@nimbus-dev/sdk";

import type { GitRunner } from "./self-person.ts";

/** Request params. `personId` targets someone other than the local user (see spec § 3.2). */
export type NegotiateInput = {
  readonly sinceMs?: number;
  /** `--person <id>`: brief a different subject. Same-machine callers only (spec § 3.1). */
  readonly personId?: string;
  readonly mePersonIdOverride?: string;
  readonly runGitOverride?: GitRunner;
  readonly osUsernameOverride?: string;
};

export type NegotiateSubject = {
  readonly personId: string | null;
  readonly source: "override" | "git" | "os" | "unresolved" | "explicit";
  readonly displayName: string | null;
  /** True when `--person` named someone other than the resolved local user. */
  readonly isOther: boolean;
};

/**
 * Coverage for an aggregate computed over a subset. `total` is the denominator the
 * aggregate SHOULD have covered; `covered` is what it actually did. Rendered only
 * when `covered < total` — spec § 5.B, matching `decisions`' conditional note.
 */
export type NegotiateCoverage = {
  readonly covered: number;
  readonly total: number;
};

export type NegotiateBrief = {
  readonly kind: "negotiate";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: { readonly sinceMs: number };
  readonly subject: NegotiateSubject;
  /** Sources the brief drew on, including whether personal documents were configured (§ 5.F). */
  readonly sources: {
    readonly personalDocsConfigured: boolean;
    readonly personalDocsConfigKey: string;
  };
  /**
   * Evidence the index cannot supply at all (spec § 5.D). Rendered unconditionally so an
   * empty section is never read as a zero. Deliberately NOT a GapNote: these are not gaps
   * in this run, they are permanent limits of the index.
   */
  readonly unavailableEvidence: readonly string[];
  /**
   * `null` means the lane failed (or never ran — e.g. no resolved subject) and a matching
   * gap note explains why; a non-null value with all-zero counts means the lane ran and
   * found nothing. Never collapse the two (Task 1 § 4).
   */
  readonly authoredPrs: NegotiateAuthoredPrs | null;
  readonly reviewedPrs: NegotiateReviewedPrs | null;
};

export type NegotiateAuthoredPrs = {
  readonly count: number;
  readonly merged: number;
  readonly stats: {
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
  } | null;
  readonly statsCoverage: NegotiateCoverage;
};

export type NegotiateReviewedPrs = {
  readonly count: number;
  readonly approved: number;
  readonly changesRequested: number;
  /** `commented`, `dismissed`, or a null `metadata.state` — counted, never dropped. */
  readonly otherOrUnknown: number;
};
