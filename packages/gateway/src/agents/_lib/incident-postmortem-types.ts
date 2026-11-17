import type { GapNote } from "@nimbus-dev/sdk";

import type { IncidentRecordV1 } from "../../incident/incident-record-types.ts";
import type { Timeline } from "../../incident/timeline.ts";

/**
 * The `incident_postmortem` brief (Phase 10 IC7a). A pure function of one stored incident record, its
 * timeline and the audit rows linked to it builds this (`incident/postmortem-brief.ts`);
 * `incident-postmortem-render.ts` renders it with no model. It is a brief KIND for the I31 machinery
 * (reserved `## Timeline`, `## Decision log`, `## Gaps` and `## Data freshness`), not an `agents/`
 * emitter: nothing here answers an `agents.*` request (static D22(d)). Types only.
 */

/** The sections a template may place with `{{id}}`, in the default order. */
export const POSTMORTEM_SECTION_IDS = [
  "summary",
  "impact_window",
  "timeline",
  "candidate_causes",
  "contributing_factors",
  "what_we_did",
  "action_items",
  "decision_log",
] as const;
export type PostmortemSectionId = (typeof POSTMORTEM_SECTION_IDS)[number];

/** A parsed `--template` file: literal text and section placeholders, in file order. */
export type PostmortemTemplate = {
  readonly parts: readonly (
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "section"; readonly id: PostmortemSectionId }
  )[];
};

export type PostmortemImpact = {
  readonly openedMs: number | null;
  readonly openedBasis: "provider" | "observed" | "none";
  readonly resolvedMs: number | null;
  /** `history` is the trigger's own `item_history` (the sync observed the status change). */
  readonly resolvedBasis: "provider" | "observed" | "history" | "none";
};

/** One Nimbus action linked to the record (`engine/incident-link.ts`), as its gate row recorded it. */
export type PostmortemAction = {
  readonly auditId: number;
  readonly timestamp: number;
  readonly actionType: string;
  readonly verdict: "approved" | "denied" | "undone";
  readonly answerSource: string | undefined;
  readonly subSteps: number;
  readonly linkVersion: number;
  /** The shown prompt as the audit row kept it (redacted, cut), or null when the row kept none. */
  readonly prompt: { readonly sha256: string; readonly text: string; readonly cut: boolean } | null;
};

export type IncidentPostmortemBrief = {
  readonly kind: "incident_postmortem";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly record: IncidentRecordV1;
  readonly recordId: string;
  readonly impact: PostmortemImpact;
  readonly timeline: Timeline;
  readonly actions: readonly PostmortemAction[];
  /** True when the audit scan hit its cap, so later linked actions are missing. */
  readonly actionsTruncated: boolean;
  /** null renders the default template. */
  readonly template: PostmortemTemplate | null;
};
