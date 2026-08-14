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

/**
 * One item behind a lane's headline count — the citation half of the brief.
 *
 * A count with no way to check it is an assertion, not evidence: "12 PRs" is exactly as
 * legible as "40 PRs" to a reader who cannot open either. These refs are what make the
 * document checkable by the person on the other side of the conversation.
 *
 * `url` is `COALESCE(item.canonical_url, item.url)` and is NULLABLE — not every connector
 * records one. A missing url renders as plain text rather than a dead link, and never as a
 * fabricated one: a wrong link in a compensation document is worse than no link.
 */
export type NegotiateEvidenceRef = {
  readonly title: string;
  readonly url: string | null;
};

/**
 * The bounded evidence list behind one lane.
 *
 * `refs` is capped at `NEGOTIATE_EVIDENCE_LIMIT` (`negotiate.ts`) — a year-long window can
 * hold hundreds of PRs and an unbounded dump is not a brief. `total` is the population the
 * refs were drawn from, so truncation is SELF-DISCLOSING: the renderer prints "and N more"
 * from `total - refs.length` rather than letting a capped list read as an exhaustive one.
 * That is the same rule `statsCoverage` follows — an aggregate over a subset states its own
 * denominator.
 */
export type NegotiateEvidence = {
  readonly refs: readonly NegotiateEvidenceRef[];
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
    /**
     * True only when at least one configured entry actually WIDENED the writing lane — the
     * intersection of `[negotiate] personal_sources` with the personal-capable service list
     * (`negotiate.ts` `splitPersonalSources`), never `personalSources.length > 0`. A
     * configured-but-matching-nothing list is an undercount; rendering it as "configured and
     * included" would state complete coverage over one.
     */
    readonly personalDocsConfigured: boolean;
    /** The configured entries that matched a personal-capable service, in a stable order. */
    readonly personalDocsRecognised: readonly string[];
    /**
     * Configured entries that match no personal-capable service and therefore contributed
     * nothing. Carried rather than dropped: a silently ignored typo is indistinguishable from
     * a source that was genuinely empty.
     */
    readonly personalDocsUnrecognised: readonly string[];
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
  readonly incidents: NegotiateIncidents | null;
  readonly tickets: NegotiateTickets | null;
  readonly ownership: NegotiateOwnership | null;
  readonly decisions: NegotiateDecisions | null;
  readonly writing: NegotiateWriting | null;
};

/**
 * Docs, notes and messages authored (spec § 3, lane 6). Each field counts as zero, not
 * `null`, when no personal source is configured (or matches) — a configured-but-empty
 * result is a real zero, not "could not be computed".
 *
 * The `[negotiate] personal_sources` gate (spec § 3.3) is per-SERVICE, not per field or
 * per item type — `negotiate.ts`'s `PERSONAL_CAPABLE_SERVICES` is the sole authority on
 * which services it covers and why; do not restate that list here; it drifts. As of that
 * list: `messages` is never gated (no chat service is personal-capable). `docs` and
 * `notes` are each a mix of always-in-scope services and personal-capable ones gated by
 * `personal_sources` — e.g. `docs` includes Confluence pages unconditionally, and Notion
 * pages only when configured, because both connectors emit the same `item.type` and the
 * gate cannot be a type filter.
 */
export type NegotiateWriting = {
  readonly docs: number;
  readonly notes: number;
  readonly messages: number;
  /** Documents, notes and messages behind the counts above, newest first. */
  readonly evidence: NegotiateEvidence;
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
  /**
   * Decisions attributed to the SUBJECT, newest first. Drawn from `authored` only — never
   * from `unattributable`, which is a fact about the index and not about this person, so
   * citing those rows here would attach someone else's decisions to this brief.
   */
  readonly evidence: NegotiateEvidence;
};

export type NegotiateAuthoredPrs = {
  readonly count: number;
  readonly merged: number;
  /** The authored PRs behind `count`, newest first. */
  readonly evidence: NegotiateEvidence;
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
  /** The reviews behind `count`, newest first. */
  readonly evidence: NegotiateEvidence;
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
  /**
   * The issues behind `opened`, newest first. `closedByAuthoredPr` is a DISTINCT count over
   * a two-hop traversal and is deliberately not cited here: its refs would be issues the
   * subject did not open, which reads as ownership of someone else's ticket.
   */
  readonly evidence: NegotiateEvidence;
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

/**
 * Incident work attributed to the subject (spec § 5.7).
 *
 * `unattributable` is a fact about the INDEX, not about this person: in-window
 * incidents carrying no person edge at all. It is counted rather than dropped
 * so a small `resolved` count cannot be read as "they did nothing" — but the
 * count names no cause: it is dominated by populations the code cannot tell
 * apart (chiefly auto-resolved incidents with no human actor, deliberately not
 * a loss — see `extractPagerdutyActors`), so asserting a specific cause (an
 * unexpanded actor payload, a token without user-read scope) would itself be a
 * false claim in the common case. The same rule `NegotiateDecisions.unattributable`
 * follows.
 */
export type NegotiateIncidents = {
  readonly resolved: number;
  readonly assigned: number;
  readonly unattributable: number;
  /**
   * Sentry error issues assigned to the subject. Counted and rendered SEPARATELY
   * from incident work, never summed into it: an error group that never paged
   * anyone is not an incident, which is exactly why Spec A gave it its own
   * entity type. Folding the two would discard that decision at the last step.
   */
  readonly errorIssuesAssigned: number;
  /** Incidents the subject RESOLVED, newest first — never drawn from `unattributable`. */
  readonly evidence: NegotiateEvidence;
};
