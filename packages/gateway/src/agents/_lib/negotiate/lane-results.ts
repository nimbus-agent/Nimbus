import type { Database } from "bun:sqlite";

import type { SubTaskResult } from "../../../engine/coordinator.ts";
import type { GapNote } from "../findings.ts";
import {
  detectMissingConnector,
  detectMissingRelationToEntityType,
  remediationForEntityType,
} from "../gap-notes.ts";
import type {
  NegotiateAuthoredPrs,
  NegotiateDecisions,
  NegotiateIncidents,
  NegotiateOwnership,
  NegotiateReviewedPrs,
  NegotiateTickets,
  NegotiateWriting,
} from "../negotiate-types.ts";

/**
 * A lane that fails degrades to a gap note, never a silent zero (spec § 4). `laneName` is
 * carried in `detail` (not just `taskIndex`) so a reader — and Task 2's red-prove test — can
 * tell which lane broke; the literal word "lane" is load-bearing for that match.
 */
function laneFailureGap(laneName: string, r: SubTaskResult): GapNote {
  return {
    category: "missing_connector",
    detail: `negotiate lane \`${laneName}\` failed${
      r.errorText === undefined ? "" : `: ${r.errorText}`
    }`,
  };
}

/**
 * Extracted from `runNegotiate` so it can be unit-tested directly against synthetic
 * `SubTaskResult[]` input: Task 1 wires this mechanism with zero real lanes (`tasks` is
 * always `[]`), so the loop body never runs end-to-end via `runNegotiate` itself, and a
 * coverage floor requires exercising it — building fake `SubTaskResult`s is the only way
 * to reach it without inventing a lane, which is Task 2's job, not Task 1's.
 */
export function reduceLaneResults(
  results: readonly SubTaskResult[],
  laneNames: readonly string[],
): GapNote[] {
  const gaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      gaps.push(laneFailureGap(laneNames[r.taskIndex] ?? `#${String(r.taskIndex)}`, r));
    }
  }
  return gaps;
}

/**
 * Resolution-aware probe for the incidents lane's `resolves -> incident` edge (spec §
 * 5.8). `detectMissingRelationToEntityType`'s shared default detail says the edge is
 * "defined in the schema but not yet emitted by the graph populator" — false here,
 * since `syncIncidentPersonEdges` emits it. Build an honest, scoped `GapNote` from its
 * result instead of changing the shared helper's detail for every other relation type
 * (the pattern `expert.ts`'s `detectUnresolvedReviewedRelation` already establishes).
 */
export function detectMissingIncidentPersonEdges(db: Database): GapNote | null {
  const missingEmit = detectMissingRelationToEntityType(db, "resolves", "incident");
  if (missingEmit === null) return null;
  const note: GapNote = {
    category: missingEmit.category,
    detail:
      "No PagerDuty incident in the index is attributed to a person — either none carry " +
      "an assignee or resolver, or their actor payloads carry no usable email.",
  };
  const remediation = remediationForEntityType("incident");
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

/**
 * Same shape as `detectMissingIncidentPersonEdges`, for the `assigned -> error_issue`
 * edge `syncErrorIssueGraph` emits. An unassigned Sentry issue is the NORM, so the
 * shared default detail's remediation (`nimbus index regraph`) would be a no-op for the
 * most common case — a user with many indexed-but-unassigned issues would be told to
 * run a command that reports "graphed N" and changes nothing. State the actual cause
 * instead.
 */
/**
 * Push at most ONE gap note for a connector-backed lane: the missing-connector note if the
 * connector is absent, otherwise the missing-edges note if it is present but has emitted
 * none.
 *
 * Ordered more fundamental cause first, and deliberately exclusive: a missing connector
 * structurally implies missing edges, so firing both would emit two notes for one root
 * cause. Written once here because the PagerDuty and Sentry blocks it replaces were the
 * same eleven lines twice, and were most of the caller's cognitive-complexity score
 * (Sonar `S3776`).
 */
export function pushConnectorOrEdgeGap(
  db: Database,
  service: string,
  detectMissingEdges: (db: Database) => GapNote | null,
  gaps: GapNote[],
): void {
  const missingConnector = detectMissingConnector(db, service);
  if (missingConnector !== null) {
    gaps.push(missingConnector);
    return;
  }
  const missingEdges = detectMissingEdges(db);
  if (missingEdges !== null) gaps.push(missingEdges);
}

export function detectMissingErrorIssuePersonEdges(db: Database): GapNote | null {
  const missingEmit = detectMissingRelationToEntityType(db, "assigned", "error_issue");
  if (missingEmit === null) return null;
  const note: GapNote = {
    category: missingEmit.category,
    detail:
      "No Sentry issue in the index is assigned to a resolvable person — either none are " +
      "assigned, or the assignee actors carry no usable email.",
  };
  const remediation = remediationForEntityType("error_issue");
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

/**
 * The seven lane-backed fields of `NegotiateBrief`, in the order their tasks are queued.
 *
 * ONE list, read by both the `laneNames` push below and `decodeLaneResults`'s guard: when the
 * two were separate string literals, a lane renamed in one place and not the other decoded to
 * nothing and left its field at `null` — indistinguishable from a lane that genuinely could
 * not be computed, which is exactly the confusion the whole null-vs-0 contract exists to
 * prevent. The order still has to match the `tasks.push` below; that pairing is positional
 * (`SubTaskResult.taskIndex`) and is not something a type can carry.
 */
export const NEGOTIATE_LANE_FIELDS = [
  "authoredPrs",
  "reviewedPrs",
  "tickets",
  "ownership",
  "decisions",
  "writing",
  "incidents",
] as const;
type NegotiateLaneField = (typeof NEGOTIATE_LANE_FIELDS)[number];

function isNegotiateLaneField(name: string | undefined): name is NegotiateLaneField {
  return name !== undefined && (NEGOTIATE_LANE_FIELDS as readonly string[]).includes(name);
}

/** The seven lane-backed fields, each `null` until its lane decodes successfully. */
type NegotiateLaneValues = {
  authoredPrs: NegotiateAuthoredPrs | null;
  reviewedPrs: NegotiateReviewedPrs | null;
  tickets: NegotiateTickets | null;
  ownership: NegotiateOwnership | null;
  decisions: NegotiateDecisions | null;
  writing: NegotiateWriting | null;
  incidents: NegotiateIncidents | null;
};

/**
 * Decode each completed lane's JSON into its field, appending a `laneFailureGap` to `gaps`
 * for any lane whose text will not parse.
 *
 * Lifted out of `runNegotiate` to bring it back under the cognitive-complexity gate (Sonar
 * S3776, was 20): the seven-arm `else if` chain this replaces was most of that score. A lane
 * that never ran, ran and failed, or decoded to nothing all leave their field at `null` —
 * unchanged from the chain, and the whole point of the mechanism.
 *
 * The single `as NegotiateLaneValues` stands in for the seven per-lane `as` casts it
 * replaces; it asserts the same thing they did (each lane's task returns the shape its field
 * declares) in one place instead of seven, and `Record<NegotiateLaneField, unknown>`
 * guarantees every key is present before the assertion is made.
 */
export function decodeLaneResults(
  results: readonly SubTaskResult[],
  laneNames: readonly string[],
  gaps: GapNote[],
): NegotiateLaneValues {
  const out: Record<NegotiateLaneField, unknown> = {
    authoredPrs: null,
    reviewedPrs: null,
    tickets: null,
    ownership: null,
    decisions: null,
    writing: null,
    incidents: null,
  };
  for (const r of results) {
    // A non-`done` lane already got its gap from `reduceLaneResults`; only a DECODE failure
    // is this function's to report.
    if (r.status !== "done" || r.text === undefined) continue;
    const laneName = laneNames[r.taskIndex];
    try {
      const decoded: unknown = JSON.parse(r.text);
      if (isNegotiateLaneField(laneName)) out[laneName] = decoded;
    } catch {
      gaps.push(laneFailureGap(laneName ?? `#${String(r.taskIndex)}`, r));
    }
  }
  return out as NegotiateLaneValues;
}
