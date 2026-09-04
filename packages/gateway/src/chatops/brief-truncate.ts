import type { SynthInput } from "../agents/_lib/brief-kinds.ts";
import { sectionBody, stripSections, topLevelSections } from "../agents/_lib/markdown-sections.ts";
import {
  GAPS_HEADING,
  GLOSSARY_TERMS_HEADING,
  isDisclosureOnlyHeading,
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
 * FIX 2 (whole-branch review): the notice for the forced-fit path below, where content — not just
 * "a section" — was actually cut. Deliberately worded differently from `noticeFor` above: that
 * notice says sections were OMITTED (true — the body was dropped whole, nothing inside a kept
 * section was touched); this one says content was CUT, because it is: a `## Terms` table (or, in
 * the last-resort case, a disclosure itself) had bytes removed from the middle/end of what would
 * otherwise be reserved-whole content. Conflating the two wordings would understate what happened
 * for a reader deciding whether to trust the brief as printed.
 *
 * D3 (whole-branch re-review): this path is reached only AFTER the ordinary body-dropping loop
 * already failed — meaning `bodySectionsOmitted` whole body sections (the preamble possibly among
 * them) were ALSO dropped, same as the ordinary `noticeFor` path reports. The forced-fit notice
 * used to drop that count entirely once content was cut too, so the reader learned LESS on the
 * path where MORE was lost. `extras` carries every applicable clause (the omitted-sections count,
 * the glossary shrink count) so none of that information goes missing just because a byte-cut was
 * also needed.
 */
function forcedOverflowNoticeFor(kind: string, extras: readonly string[]): string {
  const suffix = extras.length === 0 ? "" : ` — ${extras.join(", ")}`;
  return `_(truncated — content was cut to fit the chat size limit${suffix}; run \`nimbus ${kind}\` locally for the full brief)_`;
}

/** Byte-safe truncation to at most `maxBytes` UTF-8 bytes: backs off from a raw slice until the
 *  boundary is not a UTF-8 continuation byte (top two bits `10`), so a multi-byte codepoint is
 *  never split into an invalid trailing fragment. */
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // `end <= buf.length` throughout (started at `maxBytes < buf.length`, only decremented), so
  // `buf[end]` is always in range — the `?? 0` is just satisfying `noUncheckedIndexedAccess`
  // without a forbidden non-null assertion (biome `lint/style/noNonNullAssertion`); 0's top two
  // bits are `00`, never `10`, so a hypothetical out-of-range read would end the loop rather than
  // read past the buffer.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * The `- **term**` bullet that opens each entry `renderGlossaryTermsSection`
 * (`agents/_lib/render.ts`) emits inside the `## Terms` reserved block. Scoped to THIS block only
 * (matched by heading, below) — coupling to the renderer's exact bullet form is acceptable here
 * because this function exists specifically to shrink that one block; it is not a generic
 * markdown-entry heuristic applied blind.
 */
/** The literal an entry line opens with. Anchored, so `startsWith` says it directly. */
const GLOSSARY_ENTRY_START = "- **";

/** Line indices where a glossary entry starts within an already-extracted `## Terms` block's
 *  markdown. Found dynamically rather than an assumed line offset, so this stays correct even if
 *  the renderer's preamble (heading + the "_Ranked by relevance score…_" caption) grows or
 *  shrinks by a line. */
function glossaryEntryStarts(blockMarkdown: string): number[] {
  const lines = blockMarkdown.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith(GLOSSARY_ENTRY_START)) starts.push(i);
  }
  return starts;
}

/** `glossaryEntryStarts`, but tolerant of "no block" or "not actually the `## Terms` block" —
 *  both narrowed and handled inside this one function so a caller never needs its own
 *  `x !== undefined && x.heading === ...` guard just to satisfy the type checker. */
function glossaryEntryStartsOf(block: ReservedBlock | undefined): number[] {
  return block?.heading === GLOSSARY_TERMS_HEADING ? glossaryEntryStarts(block.markdown) : [];
}

/** The glossary `## Terms` block's own preamble plus its first `kept` entries (never a byte cut
 *  mid-entry) — `kept <= 0` returns just the preamble. */
function glossaryTermsBlockKeeping(
  block: ReservedBlock,
  entryStarts: number[],
  kept: number,
): string {
  const lines = block.markdown.split("\n");
  const end = kept <= 0 ? (entryStarts[0] ?? lines.length) : (entryStarts[kept] ?? lines.length);
  return lines.slice(0, end).join("\n").trimEnd();
}

/**
 * FIX 2 (whole-branch review): the cap must always bind, even across the reserved blocks alone.
 * Reached only when body-dropping (the main loop in `truncateBrief` below) could not bring the
 * brief under `maxBytes` even with the entire ordinary body — preamble included — gone.
 *
 * Structured as ONE loop building the REAL final candidate (disclosure blocks verbatim, `##
 * Terms` shrunk to `kept` entries, the REAL notice reflecting that exact count) and checking its
 * ACTUAL byte length at each step — the same shape as `truncateBrief`'s own body-dropping loop —
 * rather than pre-computing a byte BUDGET per section and hoping the pieces add up: a two-phase
 * estimate that turns out optimistic by even a few bytes (the notice's own count suffix varies in
 * length) would have to claw the difference back from SOMEWHERE, and reaching for the end of the
 * joined string risked silently eating into a disclosure section that follows `## Terms` in
 * render order — exactly the outcome this function exists to prevent. Building and measuring the
 * real candidate at each `kept` cannot make that mistake, because nothing is ever assumed to fit.
 *
 * `## Terms` (`GLOSSARY_TERMS_HEADING`) is reserved for SYNTHESIS integrity, not disclosure (see
 * `SYNTHESIS_RESERVED_HEADINGS`'s doc comment), so it is shrunk FIRST and disclosure blocks are kept
 * fully verbatim through every iteration of the loop: an honest partial table loses no
 * disclosure. Only once `## Terms` is shrunk all the way to nothing (or there was none to begin
 * with) and it STILL doesn't fit does this fall through to the absolute last resort below, which
 * reserves room for the notice FIRST and cuts disclosure content to what's left — because a
 * cap-abiding message that doesn't explain itself is barely better than one that silently exceeds
 * the cap, and posting over-cap for the platform to mangle server-side is worse than either.
 *
 * `bodySectionsOmitted` (D3, whole-branch re-review) is the count `truncateBrief`'s own
 * body-dropping loop already computed before falling through here — the same number the ORDINARY
 * `noticeFor` path would have reported. Threading it through means the forced-fit notice never
 * says LESS than the path it replaces: the reader still learns how many body sections vanished,
 * even on the path where content was additionally cut.
 */
function assembleReservedForcedFit(
  kind: string,
  reservedBlocks: readonly ReservedBlock[],
  maxBytes: number,
  bodySectionsOmitted: number,
): string {
  // The one reserved block held back for SYNTHESIS integrity rather than disclosure (I31) —
  // today always `## Terms`, if present at all — is the shrink candidate. Found via
  // `isDisclosureOnlyHeading` (fail-CLOSED: an unrecognised heading is never a candidate) rather
  // than a hardcoded `GLOSSARY_TERMS_HEADING` equality check, so a future second
  // synthesis-reserved heading is picked up here automatically once it is added to
  // `SYNTHESIS_RESERVED_HEADINGS` — and, until it is, it stays correctly classified as disclosure
  // rather than silently becoming droppable.
  const synthBlock = reservedBlocks.find((b) => !isDisclosureOnlyHeading(b.heading));
  const isGlossaryTerms = synthBlock?.heading === GLOSSARY_TERMS_HEADING;
  const entryStarts = glossaryEntryStartsOf(synthBlock);
  // A recognised (glossary) synthesis block shrinks per-entry; an unrecognised one — none exist
  // today — is opaque and can only be present (1) or fully dropped (0).
  const opaqueKept = synthBlock === undefined ? 0 : 1;
  const maxKept = isGlossaryTerms ? entryStarts.length : opaqueKept;

  // D3: every notice built in this function carries the omitted-body-sections count FIRST (when
  // there is one), then whatever else applies (the glossary shrink count) — never just the latter.
  const omittedExtra =
    bodySectionsOmitted > 0 ? `${String(bodySectionsOmitted)} sections omitted` : undefined;

  const candidateAt = (kept: number): string => {
    const parts = reservedBlocks
      .map((b) => {
        if (b !== synthBlock) return b.markdown;
        if (isGlossaryTerms) return glossaryTermsBlockKeeping(b, entryStarts, kept);
        // Opaque block: present in full, or gone entirely. There is no middle state.
        return kept > 0 ? b.markdown : "";
      })
      .filter((text) => text !== "");
    const extras = [
      omittedExtra,
      isGlossaryTerms && kept < maxKept
        ? `showing ${String(kept)} of ${String(maxKept)} terms`
        : undefined,
    ].filter((e): e is string => e !== undefined);
    return [...parts, forcedOverflowNoticeFor(kind, extras)].join("\n\n");
  };

  for (let kept = maxKept; kept >= 0; kept--) {
    const candidate = candidateAt(kept);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }

  // The synthesis-reserved block is fully gone (or there was none) and it STILL doesn't fit — a
  // disclosure section itself is pathologically large. Reserve room for the notice FIRST, then
  // cut disclosure content to whatever's left.
  const finalExtras = [
    omittedExtra,
    isGlossaryTerms ? `showing 0 of ${String(maxKept)} terms` : undefined,
  ].filter((e): e is string => e !== undefined);
  const notice = forcedOverflowNoticeFor(kind, finalExtras);
  const noticeBytes = Buffer.byteLength(`\n\n${notice}`, "utf8");
  if (noticeBytes >= maxBytes) {
    // The notice alone does not fit — only reachable with a pathologically small maxBytes (e.g. a
    // unit test) — so there is no budget left for any content at all.
    return truncateUtf8Bytes(notice, maxBytes);
  }
  // D2 (whole-branch re-review, accepted as latent — not fixed here): joins ALL disclosure blocks
  // in `RESERVED_HEADINGS_BY_KIND` order and cuts from the END, so whichever disclosure heading is
  // listed LAST for `kind` is the one destroyed first if this line ever has to cut. Every
  // chat-reachable kind today has at most ONE disclosure block, so this is unreachable in
  // practice — except `negotiate`, whose order is `[## Sources, ## Evidence not available from the
  // index, ## Gaps]` (`reserved-sections.ts`), which would put `## Gaps` first on the chopping
  // block. `negotiate` is excluded from every external surface today
  // (`agents-rpc.ts`'s `EXTERNAL_EXCLUDED_AGENT_METHODS`), so this never fires — but whoever
  // admits `negotiate` to a chat-reachable surface must revisit this line first: either reorder so
  // the least-recoverable disclosure is cut last, or give each disclosure block its own reserved
  // sub-budget instead of one shared byte-cut across the joined string.
  const otherParts = reservedBlocks
    .filter((b) => b !== synthBlock)
    .map((b) => b.markdown)
    .join("\n\n");
  const contentBudget = maxBytes - noticeBytes;
  const content =
    Buffer.byteLength(otherParts, "utf8") <= contentBudget
      ? otherParts
      : truncateUtf8Bytes(otherParts, contentBudget);
  return [content, notice].filter((s) => s !== "").join("\n\n");
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
 * The reserved blocks are the LAST drop candidate, never the first: ordinary body content is
 * always sacrificed before a single byte of a reserved block is touched. But FIX 2 (whole-branch
 * review) means they are not an EXEMPT one either — if the reserved blocks alone, with every
 * scrap of body content including the preamble already gone, still exceed `maxBytes`, this cap
 * must still bind: see `assembleReservedForcedFit`, which shrinks the SYNTHESIS-reserved
 * `## Terms` block first (an honest partial table loses no disclosure) and only cuts a genuine
 * disclosure's own bytes as an absolute last resort, always with an unambiguous "content was cut"
 * notice. Posting over the cap — left for the receiving chat platform to mangle server-side — is
 * never the outcome; a stated, honest cut always is.
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

  // Every body section — the preamble included — is gone, and it still doesn't fit. This is the
  // reserved-blocks-alone case: try it as-is first (the common case: the reserved content by
  // itself already fits), and only reach for the forced-fit path (FIX 2) when it does not.
  const bodySectionsOmitted = sections.length + (preamble === "" ? 0 : 1);
  const reservedOnly = candidateFor(assembleBody(0, false), bodySectionsOmitted);
  if (Buffer.byteLength(reservedOnly, "utf8") <= maxBytes) return reservedOnly;
  return assembleReservedForcedFit(kind, reservedBlocks, maxBytes, bodySectionsOmitted);
}
