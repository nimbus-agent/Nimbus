import { renderIncidentInvestigation } from "../agents/_lib/incident-investigation-render.ts";
import type { IncidentInvestigationBrief } from "../agents/_lib/incident-types.ts";
import { renderInvestigation } from "../agents/_lib/investigation-render.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { type SynthesisProvenance, synthesize } from "../agents/_lib/synthesize.ts";
import type { Investigation } from "../incident/investigate.ts";

/**
 * `nimbus incident investigate --synthesize` (Phase 10 IC9a, the model half the row left open). Lives OUTSIDE
 * `incident/**` for the reason `postmortem/postmortem-draft.ts` does: it is the one place a synthesis runner
 * meets an incident investigation (static D46(a) forbids a runner under `incident/`, OR-10-8). The investigation
 * itself is built, with no model, by `incident/investigate.ts`; this module only offers the finished
 * investigation to the existing `synthesize()`, which keeps `## What Nimbus did`, `## Leads`, `## Gaps` and
 * `## Data freshness` verbatim (I31), wraps what the model sees in the I11 envelope, appends a provenance
 * footer, and falls back to the deterministic render, with its own footer, on any failure.
 *
 * With no runner (synthesis off, or no provider) the answer is the deterministic investigation, byte for byte
 * what `incident.investigate` returns, and `synthesis` says the model was not asked.
 */

export type InvestigationDraft = {
  readonly recordId: string;
  readonly version: number;
  readonly markdown: string;
  /** Why the rewrite was or was not used; `{ attempted: false }` when no model could be asked. */
  readonly synthesis: SynthesisProvenance;
};

/** The brief form of an investigation: its gaps mirrored as gap notes (detail only, as the render prints them). */
export function investigationBrief(inv: Investigation, nowMs: number): IncidentInvestigationBrief {
  return {
    kind: "incident_investigation",
    agentVersion: 1,
    generatedAt: nowMs,
    latencyMs: 0,
    gaps: inv.gaps.map((g) => ({ category: "missing_entity_type" as const, detail: g.detail })),
    investigation: inv,
  };
}

export async function draftInvestigation(deps: {
  readonly investigation: Investigation;
  readonly nowMs: number;
  /** Present only when the owner passed `--synthesize` AND a model can be used. */
  readonly runner?: SynthesisRunner | undefined;
}): Promise<InvestigationDraft> {
  const inv = deps.investigation;
  if (deps.runner === undefined) {
    return {
      recordId: inv.recordId,
      version: inv.version,
      markdown: renderInvestigation(inv),
      synthesis: { attempted: false, reason: "disabled" },
    };
  }
  const brief = investigationBrief(inv, deps.nowMs);
  const out = await synthesize(brief, { runner: deps.runner });
  return {
    recordId: inv.recordId,
    version: inv.version,
    markdown: out.markdown,
    synthesis: out.provenance,
  };
}

/** The deterministic render the synthesized form falls back to (exported for the tests that pin both). */
export const deterministicInvestigationBrief = renderIncidentInvestigation;
