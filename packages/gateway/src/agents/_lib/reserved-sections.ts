import type { SynthInput } from "./brief-kinds.ts";
import {
  GLOSSARY_TERMS_HEADING,
  renderGaps,
  renderGlossaryTermsSection,
  renderNegotiateEvidenceSection,
  renderNegotiateSources,
} from "./render.ts";

/** A disclosure-only section held back from the model and re-attached verbatim (I31). */
export type ReservedBlock = { readonly heading: string; readonly markdown: string };

export const GAPS_HEADING = "## Gaps";
/**
 * `glossary` list mode's entry table (F31a).
 *
 * Reserved, because in that mode the DATA IS THE BRIEF. An accepted synthesis kept the term names
 * and mention counts and dropped every definition, provenance, service spread, date range and
 * cited source, replacing them with two content-free sentences about the data. I31 permitted it
 * correctly — glossary requires a phrase only in `term` mode — and a phrase check is the wrong
 * tool here anyway: a table of structured rows has no prose worth preserving through a rewrite,
 * so withhold-and-re-attach fits it better than any anchor could.
 */
export { GLOSSARY_TERMS_HEADING } from "./render.ts";
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
    glossary: [GLOSSARY_TERMS_HEADING, GAPS_HEADING],
    decisions: [GAPS_HEADING],
    ownership: [GAPS_HEADING],
    premortem: [GAPS_HEADING],
    negotiate: [NEGOTIATE_SOURCES_HEADING, NEGOTIATE_EVIDENCE_HEADING, GAPS_HEADING],
  });

export function reservedHeadingsFor(brief: SynthInput): readonly string[] {
  return RESERVED_HEADINGS_BY_KIND[brief.kind];
}

/**
 * The reserved headings held back for SYNTHESIS integrity (F31a) rather than DISCLOSURE integrity
 * (I31) — today, exactly `GLOSSARY_TERMS_HEADING`: `## Terms` is the brief's own DATA (glossary
 * list mode), not a claim ABOUT the brief. That distinction matters to `chatops/brief-truncate.ts`
 * (FIX 2, whole-branch review): when a chat-size cap cannot be met even with the entire ordinary
 * body dropped, an honest partial `## Terms` table loses no disclosure and is the right thing to
 * shrink FIRST — a `## Gaps`/`## Sources`/`## Evidence not available from the index` section is
 * NOT, since THOSE are exactly what I31 exists to keep whole.
 *
 * This is the POSITIVE, explicit membership set — the only headings the forced-fit path in
 * `brief-truncate.ts` may ever pick as its drop/shrink candidate. `isDisclosureOnlyHeading` below
 * treats every heading NOT in this set as disclosure-only, including one this module has never
 * seen before: **fail-CLOSED on the unknown**.
 *
 * That direction is deliberate, and inverts an earlier version of this file that got it backwards
 * (whole-branch review, finding D1). The original shape was a `DISCLOSURE_ONLY_HEADINGS` set, and
 * `brief-truncate.ts` treated everything ABSENT from it as droppable — fail-OPEN: a future
 * disclosure-only heading added to `RESERVED_HEADINGS_BY_KIND` (a fifteenth brief kind, or a new
 * heading on an existing one) but never added to that set would silently become the FIRST thing
 * the chat-transport truncator cuts, whole, behind only a generic "content was cut" notice — I31's
 * failure mode, reintroduced one layer down. That version's own comment claimed the two sets
 * "cannot drift out of sync" — a FALSE ATTESTATION: nothing enforced it (no type relation, no
 * test, no static rule; `grep -rn DISCLOSURE_ONLY_HEADINGS packages scripts` found only the
 * definition, its one consumer, and prose). `reserved-sections.test.ts` now pins the fail-closed
 * default directly: an unrecognised heading is never treated as droppable.
 */
export const SYNTHESIS_RESERVED_HEADINGS: ReadonlySet<string> = new Set([GLOSSARY_TERMS_HEADING]);

/**
 * True for a reserved heading that must be treated as a DISCLOSURE (I31) — never the drop/shrink
 * candidate in `chatops/brief-truncate.ts`'s forced-fit path. The default is disclosure (`true`)
 * for anything not explicitly known to be synthesis-reserved: membership in
 * `SYNTHESIS_RESERVED_HEADINGS` is the only way to become droppable, so an unrecognised heading —
 * one this function has never been told about — degrades to the SAFE outcome (kept whole, at worst
 * cut only as the absolute last resort alongside every other disclosure) rather than the unsafe one
 * (dropped first, silently).
 */
export function isDisclosureOnlyHeading(heading: string): boolean {
  return !SYNTHESIS_RESERVED_HEADINGS.has(heading);
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
    blocks.push(
      {
        heading: NEGOTIATE_SOURCES_HEADING,
        markdown: renderNegotiateSources(brief.sources).trim(),
      },
      {
        heading: NEGOTIATE_EVIDENCE_HEADING,
        markdown: renderNegotiateEvidenceSection(brief.unavailableEvidence).trim(),
      },
    );
  }
  if (brief.kind === "glossary" && brief.mode === "list") {
    // Only in list mode. `term` mode renders one entry as prose the model is meant to improve,
    // and `miss` has no entries at all — reserving a heading neither of them emits would leave
    // an empty block to re-attach.
    const terms = renderGlossaryTermsSection(brief.entries).trim();
    if (terms !== "") blocks.push({ heading: GLOSSARY_TERMS_HEADING, markdown: terms });
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
