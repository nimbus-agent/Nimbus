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
  readonly tickets: NegotiateTickets | null;
  readonly ownership: NegotiateOwnership | null;
  readonly decisions: NegotiateDecisions | null;
  readonly writing: NegotiateWriting | null;
};

/**
 * Docs, notes and messages authored (spec § 3, lane 6). `notes` (Obsidian's `obsidian_note`
 * type) is the personal-documents content the `[negotiate] personal_sources` gate targets
 * (spec § 3.3) — it counts as zero, not `null`, when no personal source is configured; a
 * configured-but-empty result is a real zero, not "could not be computed". `docs`/`messages`
 * are work artifacts and are always in scope.
 */
export type NegotiateWriting = {
  readonly docs: number;
  readonly notes: number;
  readonly messages: number;
};

/**
 * `decision_record.source_item_id` joins to `item`, and the item's `author_id` gives the
 * decision's author — but `obsidian-sync.ts` and `teams-sync.ts` set no `authorId` at all,
 * so a decision mined from those sources resolves to an item with `author_id IS NULL`.
 * `unattributable` counts those rows rather than silently dropping them from the
 * denominator (spec § 8.2, Task 5 brief).
 */
export type NegotiateDecisions = {
  readonly authored: number;
  /** Decisions whose source item has no author — counted, never dropped (spec § 8.2). */
  readonly unattributable: number;
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

/**
 * `opened` traverses `person --opened--> issue`. `closedByAuthoredPr` traverses
 * `person --authored--> pr --resolves--> issue` — a `resolves` edge is emitted by
 * `syncPrGraph` from issue references (e.g. "closes #7") in the PR body, and only wires
 * against an issue entity that already exists in `graph_entity` at PR-sync time.
 */
export type NegotiateTickets = {
  readonly opened: number;
  readonly closedByAuthoredPr: number;
};

/**
 * Precomputed `owns` edges (the ownership pass, `ownership/ownership-pass.ts`), aggregated
 * to directory/service level only — this lane never lists files (spec § 5.A0).
 */
export type NegotiateOwnership = {
  readonly services: string[];
  readonly directories: string[];
  /** `ownership_pass_state.last_pass_at`; null when the pass has never run. */
  readonly lastPassAt: number | null;
  /** True when the `LIMIT` clipped the result — rendered so a partial list never reads as complete. */
  readonly truncated: boolean;
  /**
   * `COUNT(*)` of `git:`-prefixed `person` entities anywhere in the index — a true statement
   * about the index, never an attribution to the subject (spec § 5.A0: a heuristic match by
   * name/email would produce a wrong attribution, which is worse than an acknowledged gap).
   */
  readonly unmappedIdentitiesInIndex: number;
};
