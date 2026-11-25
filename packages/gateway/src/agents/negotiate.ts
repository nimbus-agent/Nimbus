import type { Database } from "bun:sqlite";

import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import type { SourceMapping } from "../sources/source-mapping.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import {
  decodeLaneResults,
  detectMissingErrorIssuePersonEdges,
  detectMissingIncidentPersonEdges,
  NEGOTIATE_LANE_FIELDS,
  pushConnectorOrEdgeGap,
  reduceLaneResults,
} from "./_lib/negotiate/lane-results.ts";
import { laneAuthoredPrs, laneReviewedPrs } from "./_lib/negotiate/lanes-prs.ts";
import {
  laneDecisions,
  laneIncidents,
  laneOwnership,
  laneTickets,
} from "./_lib/negotiate/lanes-work.ts";
import { laneWriting, personalDocsSources } from "./_lib/negotiate/lanes-writing.ts";
import { detectUnmappedGitIdentity, resolveSubject } from "./_lib/negotiate/subject.ts";
import { unresolvedIdentityGap } from "./_lib/negotiate/subject-gaps.ts";
import { agentActionExclusions, NO_AGENT_ACTIONS } from "./_lib/negotiate-agent-actions.ts";
import type { NegotiateBrief, NegotiateInput } from "./_lib/negotiate-types.ts";
import { subAgent } from "./_lib/sub-agent.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

export { NEGOTIATE_EVIDENCE_LIMIT } from "./_lib/negotiate/evidence.ts";
export { OWNERSHIP_LIMIT } from "./_lib/negotiate/lanes-work.ts";
export { reduceLaneResults };

const DEFAULT_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * The agent's own window ceiling — a year, sized for an annual review cycle rather than
 * `catchup`'s "what happened while I was away" quarter. EXPORTED so `ipc/agents-rpc/params-people.ts`'s
 * `requireNegotiateParams` validates against this same literal instead of re-declaring it:
 * two copies drifting apart fails SILENTLY (the IPC accepts a window the agent then clamps),
 * which is exactly the silent-clamping bug the explicit IPC rejection exists to prevent.
 */
export const MAX_SINCE_MS = 365 * 24 * 60 * 60 * 1000;

export type NegotiateContext = {
  db: Database;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  /**
   * `[negotiate] personal_sources` (spec § 3.3): personal-document services the local
   * owner has named as in scope. Not optional — a caller must resolve config (or supply
   * `[]`) explicitly rather than silently disabling an opt-in the user believes is active.
   */
  personalSources: readonly string[];
  /**
   * The effective source mapping (`sourceMappingFor(configDir)`, built per call by the caller).
   * Required for the same reason as `personalSources`: the decisions lane counts and cites only
   * decisions whose source is mapped now, and a default would silently count excluded ones.
   */
  mapping: SourceMapping;
};

const UNAVAILABLE_EVIDENCE: readonly string[] = Object.freeze([
  "on-call shifts",
  "deploys triggered",
]);

export async function runNegotiate(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<NegotiateBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_SINCE_MS, MAX_SINCE_MS);
  const gaps: GapNote[] = [];

  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) gaps.push(empty);

  const { subject, gitEmailAttempted, subjectGap } = await resolveSubject(ctx.db, input);
  if (subject.personId === null) gaps.push(unresolvedIdentityGap());
  if (subjectGap !== null) gaps.push(subjectGap);
  // Never when `--person` named SOMEONE ELSE — their alias set is unknowable from here
  // (spec § 5.A0); `gitEmailAttempted` is only meaningful for the local self. Keyed on
  // `isOther`, not on `source === "explicit"`: `--person <your own id>` is still a brief
  // about you, resolved from your own git email, and dropping the undercount caveat there
  // would render a bare run and an explicit self run identically while one of them silently
  // omits a disclosure the other makes.
  if (!subject.isOther) {
    const gitGap = detectUnmappedGitIdentity(ctx.db, gitEmailAttempted);
    if (gitGap !== null) gaps.push(gitGap);
  }

  // Lane mechanism (spec § 4): every lane-backed field on `NegotiateBrief` must be
  // declared `… | null` and initialised to `null` before the coordinator runs, so a
  // lane that failed is distinguishable from a lane that ran and found nothing (`0`).
  // Each lane pushes a `{ name, task }` pair (name into `laneNames`, task into `tasks`,
  // same index); after the coordinator runs, `r.text` is decoded with `JSON.parse` for
  // `status === "done"` results and merged into the matching `NegotiateBrief` field —
  // leaving that field at `null` and pushing a `laneFailureGap` for any other status
  // (or for text that fails to decode).
  const laneNames: string[] = [];
  const tasks: SubTask[] = [];
  // Only attempt the PR lanes with a resolved subject: `laneAuthoredPrs`/`laneReviewedPrs`
  // require a concrete `personId`, and an unresolved subject already carries its own
  // `missing_user_identity` gap above — leaving these fields at their initial `null` here
  // is "not attempted", the same "could not be computed" meaning as a lane that threw.
  if (subject.personId !== null) {
    const personId = subject.personId;
    // The incidents lane's four-zero honesty contract (spec § 5.8): a structural zero
    // caused by "no PagerDuty connector" or "connector present, no incident edges yet"
    // must never render identically to a real `unattributable` measurement. Gated the
    // same as the lane itself — an unresolved subject already carries its own
    // `missing_user_identity` gap and must not also emit connector noise. Ordered more
    // fundamental cause first: no connector before no edges, since a missing connector
    // implies missing edges too and naming both would be redundant.
    // `detectMissingIncidentPersonEdges` builds an honest, scoped `GapNote` rather than
    // falling back to `detectMissingRelationToEntityType`'s shared default detail, which
    // says the edges are "not yet emitted by the graph populator" — false since
    // `syncIncidentPersonEdges` shipped.
    pushConnectorOrEdgeGap(ctx.db, "pagerduty", detectMissingIncidentPersonEdges, gaps);
    // `detectMissingErrorIssuePersonEdges` is scoped for its own reason — an unassigned
    // Sentry issue is the NORM, so the shared default's `nimbus index regraph` remediation
    // would be a no-op in the common case.
    pushConnectorOrEdgeGap(ctx.db, "sentry", detectMissingErrorIssuePersonEdges, gaps);
    // Same order as `tasks.push` below — the pairing is positional (`SubTaskResult.taskIndex`).
    // Agent-caused artifacts (I28's act door) ran on the LOCAL owner's credentials, so they can
    // only inflate the owner's own brief; for anyone else there is nothing to exclude.
    const agent = subject.isOther
      ? NO_AGENT_ACTIONS
      : agentActionExclusions(ctx.db, Date.now() - sinceMs);
    laneNames.push(...NEGOTIATE_LANE_FIELDS);
    tasks.push(
      subAgent(() => laneAuthoredPrs(ctx.db, personId, sinceMs)),
      subAgent(() => laneReviewedPrs(ctx.db, personId, sinceMs)),
      subAgent(() => laneTickets(ctx.db, personId, sinceMs, agent.tickets)),
      subAgent(() => laneOwnership(ctx.db, personId)),
      subAgent(() => laneDecisions(ctx.db, personId, sinceMs, ctx.mapping)),
      subAgent(() => laneWriting(ctx.db, personId, sinceMs, ctx.personalSources, agent.writing)),
      subAgent(() => laneIncidents(ctx.db, personId, sinceMs)),
    );
  }
  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `negotiate:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });
  const results = await coordinator.run(tasks);
  gaps.push(...reduceLaneResults(results, laneNames));

  const { authoredPrs, reviewedPrs, tickets, ownership, decisions, writing, incidents } =
    decodeLaneResults(results, laneNames, gaps);

  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    subject,
    sources: personalDocsSources(ctx.personalSources),
    unavailableEvidence: UNAVAILABLE_EVIDENCE,
    authoredPrs,
    reviewedPrs,
    incidents,
    tickets,
    ownership,
    decisions,
    writing,
  };
}

export function emitNegotiateBrief(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "negotiate.briefReady",
    briefErrorMethod: "negotiate.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runNegotiate(input, ctx),
  });
}
