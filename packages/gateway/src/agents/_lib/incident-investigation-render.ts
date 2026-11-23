import type { IncidentInvestigationBrief } from "./incident-types.ts";
import {
  actions,
  dataContext,
  freshnessLines,
  leads,
  related,
  sentry,
  summary,
} from "./investigation-render.ts";
import { hardenedPlain, type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of the investigation brief (Phase 10 IC9a, `--synthesize`), and its reserved blocks
 * (I31). Same sections and wording as `renderInvestigation` (it reuses its section builders), with the
 * disclosures a rewrite must not weaken held back under `omitReserved` and rebuilt by `reservedBlocksFor` from
 * the brief itself: `## What Nimbus did` (who decided what), `## Leads` (candidates with their timing, never a
 * cause), `## Gaps` and `## Data freshness`. The model rewrites the rest: the summary, the Sentry issues, the
 * data-quality context and the other open records.
 */

export const INVESTIGATION_ACTIONS_HEADING = "## What Nimbus did";
export const INVESTIGATION_LEADS_HEADING = "## Leads";
export const INVESTIGATION_FRESHNESS_HEADING = "## Data freshness";

export type InvestigationReservedBlock = { readonly heading: string; readonly markdown: string };

/** `## What Nimbus did` and `## Leads`, in the order the render prints them. */
export function investigationReservedBlocks(
  brief: IncidentInvestigationBrief,
): readonly InvestigationReservedBlock[] {
  const inv = brief.investigation;
  return [
    { heading: INVESTIGATION_ACTIONS_HEADING, markdown: actions(inv).trim() },
    { heading: INVESTIGATION_LEADS_HEADING, markdown: leads(inv.leads).trim() },
  ];
}

/** The `## Data freshness` block, built from the investigation itself. */
export function investigationFreshnessBlock(brief: IncidentInvestigationBrief): string {
  return [INVESTIGATION_FRESHNESS_HEADING, "", ...freshnessLines(brief.investigation)].join("\n");
}

export function renderIncidentInvestigation(
  brief: IncidentInvestigationBrief,
  opts?: RenderOpts,
): string {
  const inv = brief.investigation;
  const withheld = opts?.omitReserved === true;
  const body = [
    `# Investigation: ${hardenedPlain(inv.trigger.title, 120)}`,
    summary(inv),
    sentry(inv),
    dataContext(inv),
    related(inv),
    ...(withheld ? [] : investigationReservedBlocks(brief).map((b) => b.markdown)),
    withheld ? "" : renderGaps(brief.gaps).trim(),
    withheld ? "" : investigationFreshnessBlock(brief),
  ];
  return `${body.filter((p): p is string => p !== null && p !== "").join("\n\n")}\n`;
}
