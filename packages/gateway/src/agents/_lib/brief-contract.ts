import type { Disclosure } from "./brief-disclosures.ts";
import {
  glossaryProvenanceDisclosure,
  negotiateDecisionsDisclosure,
  negotiateIncidentsDisclosure,
  negotiateNotComputedDisclosure,
  negotiateOwnershipDisclosures,
  negotiateWindowDisclosure,
} from "./brief-disclosures.ts";
import type { SynthInput } from "./brief-kinds.ts";
import { assertNeverBrief } from "./brief-kinds.ts";
import { normalizeSectionText, preambleBody, sectionBody } from "./markdown-sections.ts";

/**
 * All SEVEN nullable negotiate lanes (`negotiate-types.ts:103-109`). `null` means the lane
 * could not be computed and MUST say so; a non-null lane reporting zero is a real
 * measurement and requires nothing — guarding it would invert the "null is not 0" rule the
 * whole honesty contract rests on.
 */
const NEGOTIATE_LANES = [
  ["authoredPrs", "PRs authored"],
  ["reviewedPrs", "PRs reviewed"],
  ["incidents", "Incidents"],
  ["tickets", "Tickets"],
  ["ownership", "Ownership"],
  ["decisions", "Decisions"],
  ["writing", "Writing"],
] as const;

/**
 * The disclosures a rewrite of `brief` must not drop.
 *
 * Every entry is built by `brief-disclosures.ts` from the SAME constant the renderer emits,
 * and under the SAME predicate — the guard cannot require a phrase the brief never rendered
 * (which would reject every synthesis), and cannot miss one it did.
 */
export function requiredPhrases(brief: SynthInput): readonly Disclosure[] {
  if (brief.kind === "negotiate") {
    // Qualifies every count in the brief, so it is required unconditionally.
    const out: Disclosure[] = [negotiateWindowDisclosure(brief.query.sinceMs, brief.generatedAt)];
    for (const [field, heading] of NEGOTIATE_LANES) {
      if (brief[field] === null) out.push(negotiateNotComputedDisclosure(heading));
    }
    // A null lane renders ONLY its "could not be computed" section — none of the interleaved
    // sentences below exist in that brief, so requiring one would reject every synthesis of
    // a partially-failed brief.
    if (brief.ownership !== null) {
      const ownership = negotiateOwnershipDisclosures(brief.ownership);
      if (ownership.truncation !== undefined) out.push(ownership.truncation);
      out.push(ownership.accountability);
    }
    if (brief.incidents !== null) {
      const incidents = negotiateIncidentsDisclosure(brief.incidents);
      if (incidents !== undefined) out.push(incidents);
    }
    if (brief.decisions !== null) {
      out.push(negotiateDecisionsDisclosure(brief.decisions, brief.subject));
    }
    return out;
  }
  if (brief.kind === "glossary") {
    // Mirrors `renderGlossaryBody` exactly: `miss` and `list` mode render no provenance
    // sentence at all, and `term` mode renders `entries[0]` and nothing else.
    if (brief.mode !== "term") return [];
    const entry = brief.entries[0];
    if (entry === undefined) return [];
    const provenance = glossaryProvenanceDisclosure(entry.term, entry.definitionSource);
    return provenance === undefined ? [] : [provenance];
  }
  // Every other brief kind returns [] until its contractual strings are added.
  // Listed explicitly so a fifteenth kind is a COMPILE error, not a silent [].
  if (
    brief.kind === "expert" ||
    brief.kind === "impact" ||
    brief.kind === "catchup" ||
    brief.kind === "ghost" ||
    brief.kind === "conflict" ||
    brief.kind === "janitor" ||
    brief.kind === "preflight" ||
    brief.kind === "why" ||
    brief.kind === "decisions" ||
    brief.kind === "ownership" ||
    brief.kind === "huddle" ||
    brief.kind === "premortem"
  ) {
    return [];
  }
  return assertNeverBrief(brief);
}

export function contractViolations(brief: SynthInput, markdown: string): string[] {
  const out: string[] = [];
  for (const { scope, anchor } of requiredPhrases(brief)) {
    if (scope.kind === "preamble") {
      if (!normalizeSectionText(preambleBody(markdown)).includes(normalizeSectionText(anchor))) {
        out.push(`the brief preamble dropped required phrase "${anchor}"`);
      }
      continue;
    }
    const body = sectionBody(markdown, scope.heading);
    if (body === undefined) {
      out.push(`missing required section "${scope.heading}"`);
      continue;
    }
    if (!normalizeSectionText(body).includes(normalizeSectionText(anchor))) {
      out.push(`section "${scope.heading}" dropped required phrase "${anchor}"`);
    }
  }
  return out;
}
