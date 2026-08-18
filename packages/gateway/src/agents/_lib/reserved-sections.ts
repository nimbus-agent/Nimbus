import type { SynthInput } from "./brief-kinds.ts";
import { renderGaps, renderNegotiateEvidenceSection, renderNegotiateSources } from "./render.ts";

/** A disclosure-only section held back from the model and re-attached verbatim (I31). */
export type ReservedBlock = { readonly heading: string; readonly markdown: string };

export const GAPS_HEADING = "## Gaps";
export const NEGOTIATE_SOURCES_HEADING = "## Sources";
export const NEGOTIATE_EVIDENCE_HEADING = "## Evidence not available from the index";

/**
 * Which sections are disclosure-only, per brief kind.
 *
 * Typed as a TOTAL `Record` over the union's `kind` literals, not a lookup with a default:
 * a fifteenth brief kind is then a COMPILE error here rather than a silent empty list that
 * would hand that kind's gap notes to the model with nothing said about it.
 *
 * Per-kind rather than one global list so a future kind that legitimately wants a `##
 * Sources` section of its own is not silently gagged by `negotiate`'s reservation.
 */
export const RESERVED_HEADINGS_BY_KIND: Readonly<Record<SynthInput["kind"], readonly string[]>> =
  Object.freeze({
    expert: [GAPS_HEADING],
    impact: [GAPS_HEADING],
    catchup: [GAPS_HEADING],
    ghost: [GAPS_HEADING],
    conflict: [GAPS_HEADING],
    huddle: [GAPS_HEADING],
    janitor: [GAPS_HEADING],
    preflight: [GAPS_HEADING],
    why: [GAPS_HEADING],
    glossary: [GAPS_HEADING],
    decisions: [GAPS_HEADING],
    ownership: [GAPS_HEADING],
    premortem: [GAPS_HEADING],
    negotiate: [NEGOTIATE_SOURCES_HEADING, NEGOTIATE_EVIDENCE_HEADING, GAPS_HEADING],
  });

export function reservedHeadingsFor(brief: SynthInput): readonly string[] {
  return RESERVED_HEADINGS_BY_KIND[brief.kind];
}

/**
 * The reserved blocks for this brief, built from the brief's own data by the SAME builders
 * the renderer uses — never recovered by scanning the rendered markdown.
 *
 * That distinction is the whole point. Brief content is not trusted markdown:
 * `renderGlossaryEntry` interpolates a definition at the start of a line, and in `snippet`
 * mode that definition is quoted verbatim from an indexed Slack message or Notion page. A
 * definition containing a `## Gaps` line would make a first-match scan extract the wrong
 * region. Constructing removes the class instead of hardening a scan against it.
 *
 * A block is present only when it has content: a brief with no gap notes reserves nothing,
 * which is why `renderGaps([])` returning `""` is checked rather than assumed.
 */
export function reservedBlocksFor(brief: SynthInput): readonly ReservedBlock[] {
  const blocks: ReservedBlock[] = [];
  if (brief.kind === "negotiate") {
    blocks.push({
      heading: NEGOTIATE_SOURCES_HEADING,
      markdown: renderNegotiateSources(brief.sources).trim(),
    });
    blocks.push({
      heading: NEGOTIATE_EVIDENCE_HEADING,
      markdown: renderNegotiateEvidenceSection(brief.unavailableEvidence).trim(),
    });
  }
  const gaps = renderGaps(brief.gaps).trim();
  if (gaps !== "") blocks.push({ heading: GAPS_HEADING, markdown: gaps });
  return blocks;
}

/** Body first, then each reserved block, one blank line between. Order is preserved. */
export function joinReserved(body: string, blocks: readonly ReservedBlock[]): string {
  if (blocks.length === 0) return body;
  return [body.trimEnd(), ...blocks.map((b) => b.markdown.trim())].join("\n\n");
}
