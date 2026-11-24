import type { IncidentUpdateBrief } from "./incident-types.ts";
import { type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of the incident-update brief (Phase 10 IC9b, `--synthesize`), and its one reserved
 * block (I31). The model is shown the facts under `## Known so far` and asked for `## Lead`: ONE short paragraph.
 * `## Update text` is the deterministic update, facts and disclosure footer included, and is RESERVED: withheld
 * from the model, rebuilt from the brief by `reservedBlocksFor` and re-attached verbatim, so anything the model
 * writes under that heading is stripped. The text that is finally offered to be posted is never parsed out of the
 * model's output: it is the model's lead (sanitised, capped) followed by `brief.text`, byte for byte.
 */

export const UPDATE_TEXT_HEADING = "## Update text";
export const UPDATE_LEAD_HEADING = "## Lead";
/** The lead of a render nobody wrote: it never reaches the posted text. */
export const UPDATE_LEAD_NONE = "_No lead written._";

/** The reserved `## Update text` block, built from the brief itself. */
export function updateTextBlock(brief: IncidentUpdateBrief): string {
  return [UPDATE_TEXT_HEADING, "", brief.text.trimEnd()].join("\n");
}

export function renderIncidentUpdateBrief(brief: IncidentUpdateBrief, opts?: RenderOpts): string {
  const withheld = opts?.omitReserved === true;
  const parts = [
    `# Incident update (${brief.audience})`,
    `${UPDATE_LEAD_HEADING}\n\n${UPDATE_LEAD_NONE}`,
    `## Known so far\n\n${brief.text.trimEnd()}`,
    withheld ? "" : updateTextBlock(brief),
    withheld ? "" : renderGaps(brief.gaps).trim(),
  ];
  return `${parts.filter((p) => p !== "").join("\n\n")}\n`;
}
