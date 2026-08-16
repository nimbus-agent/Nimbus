import type { SynthInput } from "./brief-kinds.ts";
import { assertNeverBrief } from "./brief-kinds.ts";

export type RequiredPhrase = { readonly heading: string; readonly phrase: string };

const NOT_COMPUTED = "could not be computed";

/**
 * Strip markdown emphasis and collapse whitespace so a model that re-formats a
 * phrase is not treated as one that DELETED it. Without this the guard rejects
 * every real synthesis and the feature ships inert.
 */
function normalize(s: string): string {
  return s.replace(/[_*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Body text under `## <heading>`, up to the next heading of the SAME OR HIGHER level
 * (same or fewer `#` characters) — not a heading at a deeper level.
 *
 * Heading match is a normalized PREFIX, not equality: `render.ts:789` documents headings
 * rendered as `## Ownership — services: checkout`, and exact matching would report that
 * section missing and reject an otherwise-correct synthesis.
 *
 * The level check matters for the same reason: `SYNTHESIS_INSTRUCTIONS` says "keep all
 * section headings" but does not forbid a rewrite from ADDING sub-structure — a `### Note`
 * inside `## Tickets` is realistic model output. Breaking on every `#` line would truncate
 * the section at that sub-heading, discard the disclaimer sitting below it, and report a
 * false "dropped required phrase" for a synthesis that never touched the disclaimer at
 * all. A deeper heading belongs to the section body; only a heading at the same level (a
 * sibling section) or shallower (a parent) ends it.
 */
function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const target = normalize(heading);
  const i = lines.findIndex(
    (l) => l.startsWith("#") && normalize(l.replace(/^#+/, "")).startsWith(target),
  );
  if (i < 0) return undefined;
  const openingLevel = (lines[i] ?? "").match(/^#+/)?.[0].length ?? 0;
  const body: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? "";
    const level = line.match(/^#+/)?.[0].length;
    if (level !== undefined && level <= openingLevel) break;
    body.push(line);
  }
  return body.join("\n");
}

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

export function requiredPhrases(brief: SynthInput): readonly RequiredPhrase[] {
  if (brief.kind === "negotiate") {
    const out: RequiredPhrase[] = [];
    for (const [field, heading] of NEGOTIATE_LANES) {
      if (brief[field] === null) out.push({ heading, phrase: NOT_COMPUTED });
    }
    return out;
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
    brief.kind === "glossary" ||
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
  for (const { heading, phrase } of requiredPhrases(brief)) {
    const body = sectionBody(markdown, heading);
    if (body === undefined) {
      out.push(`missing required section "${heading}"`);
      continue;
    }
    if (!normalize(body).includes(normalize(phrase))) {
      out.push(`section "${heading}" dropped required phrase "${phrase}"`);
    }
  }
  return out;
}
