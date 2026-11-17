import type { Database } from "bun:sqlite";

import { renderIncidentPostmortem } from "../agents/_lib/incident-postmortem-render.ts";
import type { PostmortemTemplate } from "../agents/_lib/incident-postmortem-types.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { type SynthesisProvenance, synthesize } from "../agents/_lib/synthesize.ts";
import { buildPostmortemBrief } from "../incident/postmortem-brief.ts";

/**
 * Drafts a post-mortem (Phase 10 IC7a, spec § 5.7). Lives OUTSIDE `incident/**` because it is the one place
 * a synthesis runner meets an incident record (static D46(a) forbids a runner there, OR-10-8): with no runner
 * the draft is the deterministic render and `synthesize` is never called; with one, the existing
 * `synthesize()` keeps `## Timeline`, `## Decision log`, `## Gaps` and `## Data freshness` verbatim (I31) and
 * falls back to the deterministic draft, with its footer, on any failure.
 */

export type PostmortemDraft = {
  readonly recordId: string;
  readonly version: number;
  readonly markdown: string;
  /** null when no model was asked for; otherwise why the rewrite was or was not used. */
  readonly synthesis: SynthesisProvenance | null;
};

export type DraftDeps = {
  readonly db: Database;
  readonly nowMs: number;
  readonly recordId: string;
  readonly template: PostmortemTemplate | null;
  /** Present only when the owner passed `--synthesize`. */
  readonly runner?: SynthesisRunner | undefined;
};

export async function draftPostmortem(deps: DraftDeps): Promise<PostmortemDraft> {
  const brief = buildPostmortemBrief(deps.db, deps.recordId, deps.nowMs, deps.template);
  if (deps.runner === undefined) {
    return {
      recordId: deps.recordId,
      version: brief.record.version,
      markdown: `${renderIncidentPostmortem(brief)}\n`,
      synthesis: null,
    };
  }
  const out = await synthesize(brief, { runner: deps.runner });
  return {
    recordId: deps.recordId,
    version: brief.record.version,
    markdown: out.markdown,
    synthesis: out.provenance,
  };
}
