import type { SynthInput } from "../agents/_lib/brief-kinds.ts";
import { sectionBody, stripSections, topLevelSections } from "../agents/_lib/markdown-sections.ts";
import {
  GAPS_HEADING,
  joinReserved,
  RESERVED_HEADINGS_BY_KIND,
  type ReservedBlock,
} from "../agents/_lib/reserved-sections.ts";

/**
 * `kind` is `RESERVED_HEADINGS_BY_KIND`'s own key type, but `truncateBrief` only receives a
 * caller-supplied agent name — a ChatOps command argument, ultimately — never a real
 * `SynthInput`. `Object.hasOwn` (never `in`, which would resolve prototype keys against a
 * caller-supplied string) proves membership and lets the cast that follows stand on that proof
 * rather than on trust.
 */
function isSynthKind(kind: string): kind is SynthInput["kind"] {
  return Object.hasOwn(RESERVED_HEADINGS_BY_KIND, kind);
}

/**
 * The disclosure-only headings for `kind`, falling back to `[GAPS_HEADING]` — every one of the
 * fourteen brief kinds' actual reserved set, `glossary` and `negotiate` alone excepted — when
 * `kind` is not a `SynthInput["kind"]` literal at all. That fallback covers a real mismatch, not
 * just a hypothetical one: the external ChatOps agent name for the `conflict` brief kind is
 * `"conflicts"` (`ipc/agents-rpc.ts`'s `EXTERNAL_AGENT_NAMES`), so the lookup below misses by
 * name for that one agent even though the two are the same brief. Falling back to `[GAPS_HEADING]`
 * is still correct there, because `conflict`'s real reserved set — like nine of the other ten
 * ChatOps-reachable kinds — IS exactly `[GAPS_HEADING]`; only `glossary` (matches by name) and
 * `negotiate` (excluded from every external surface, `agents-rpc.ts`'s
 * `EXTERNAL_EXCLUDED_AGENT_METHODS`) carry a second reserved heading, and both are unaffected by
 * this fallback.
 */
function reservedHeadingsForKind(kind: string): readonly string[] {
  return isSynthKind(kind) ? RESERVED_HEADINGS_BY_KIND[kind] : [GAPS_HEADING];
}

/** `sections[start..end)`, joined back into text with trailing whitespace trimmed. */
function sliceText(lines: readonly string[], range: { start: number; end: number }): string {
  return lines.slice(range.start, range.end).join("\n").trimEnd();
}

function noticeFor(kind: string, sectionsOmitted: number): string | undefined {
  if (sectionsOmitted <= 0) return undefined;
  return `_(truncated — ${sectionsOmitted} sections omitted; run \`nimbus ${kind}\` locally for the full brief)_`;
}

/**
 * Fit a rendered brief to a chat-platform byte cap without ever dropping a disclosure (I31).
 *
 * The disclosure-only sections for `kind` — `## Gaps` for every brief kind, plus `negotiate`'s
 * `## Sources` and `## Evidence not available from the index` — are pulled out of the ALREADY
 * RENDERED markdown with the same section machinery I31's own enforcement uses: `sectionBody` to
 * read each reserved section's content, `stripSections` to remove it from the body, and
 * `joinReserved` to reassemble. `truncateBrief` never invents its own notion of "a section" — a
 * hand-rolled `^## ` regex here would agree with the invariant almost everywhere and disagree
 * exactly at the boundary, which is precisely where a disclosure would go missing.
 *
 * Whatever remains after the reserved sections are pulled out — the body — is truncated from the
 * END, one whole heading-delimited unit at a time (`topLevelSections`, ANY heading level: a model
 * rewrite does not reliably match the renderer's own level-2 convention, so a `##`-only split
 * would let a `#`- or `###`-headed section survive untouched over the cap — the exact failure
 * this function exists to prevent, just for ordinary content instead of a disclosure), until the
 * body plus the reserved blocks plus the truncation notice fits `maxBytes`.
 *
 * The reserved blocks are NEVER a drop candidate. If they alone — with the notice, and with every
 * scrap of body content including the preamble dropped — still exceed `maxBytes`, this returns
 * them plus the notice anyway and stops there: a stated overflow is the deliberate outcome, never
 * a truncated disclosure.
 *
 * A brief that already fits is returned byte-identical — no reserved-block round trip, no notice,
 * nothing reformatted — so an untruncated brief is never distinguishable from one this function
 * merely happened not to touch.
 */
export function truncateBrief(markdown: string, kind: string, maxBytes: number): string {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;

  const headings = reservedHeadingsForKind(kind);
  const reservedBlocks: ReservedBlock[] = [];
  for (const heading of headings) {
    const body = sectionBody(markdown, heading)?.trim();
    if (body !== undefined && body !== "") {
      reservedBlocks.push({ heading, markdown: `${heading}\n\n${body}` });
    }
  }

  const bodyOnly = stripSections(markdown, headings);
  const lines = bodyOnly.split("\n");
  const sections = topLevelSections(bodyOnly);
  const preambleEnd = sections[0]?.start ?? lines.length;
  const preamble = lines.slice(0, preambleEnd).join("\n").trimEnd();

  const assembleBody = (kept: number, includePreamble: boolean): string => {
    const parts: string[] = [];
    if (includePreamble && preamble !== "") parts.push(preamble);
    for (let i = 0; i < kept; i++) {
      const range = sections[i];
      if (range !== undefined) parts.push(sliceText(lines, range));
    }
    return parts.join("\n\n");
  };

  const candidateFor = (body: string, sectionsOmitted: number): string => {
    const assembled = joinReserved(body, reservedBlocks);
    const notice = noticeFor(kind, sectionsOmitted);
    return notice === undefined ? assembled : `${assembled}\n\n${notice}`;
  };

  // Drop whole body sections from the end, keeping the preamble, until it fits.
  for (let kept = sections.length; kept >= 0; kept--) {
    const candidate = candidateFor(assembleBody(kept, true), sections.length - kept);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }

  // Every body section is gone and it still doesn't fit with the preamble kept. Drop the
  // preamble too — this is the reserved-blocks-alone case: never truncate inside a disclosure,
  // so whatever comes back here is the accepted overflow.
  return candidateFor(assembleBody(0, false), sections.length + (preamble === "" ? 0 : 1));
}
