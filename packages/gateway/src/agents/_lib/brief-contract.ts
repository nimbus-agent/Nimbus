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
 * Body text under `## <heading>`, up to the next heading of any level.
 *
 * Heading match is a normalized PREFIX, not equality: `render.ts:789` documents headings
 * rendered as `## Ownership — services: checkout`, and exact matching would report that
 * section missing and reject an otherwise-correct synthesis.
 */
function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const target = normalize(heading);
  let i = lines.findIndex(
    (l) => l.startsWith("#") && normalize(l.replace(/^#+/, "")).startsWith(target),
  );
  if (i < 0) return undefined;
  const body: string[] = [];
  for (i += 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("#")) break;
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
