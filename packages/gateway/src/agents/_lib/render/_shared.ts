import type { GapNote } from "../findings.ts";

/**
 * `omitReserved` produces the SYNTHESIZABLE half of a brief: everything except the
 * disclosure-only sections, which `synthesize.ts` re-attaches verbatim after the model
 * has run so a rewrite cannot drop them (invariant I31).
 *
 * An optional parameter rather than a changed return type: the default call stays
 * byte-identical, so every existing render test and the brief-shape snapshot are
 * untouched by this feature.
 */
export type RenderOpts = { readonly omitReserved?: boolean };

export function reserved(markdown: string, opts: RenderOpts | undefined): string {
  return opts?.omitReserved === true ? "" : markdown;
}

export function renderGaps(gaps: GapNote[]): string {
  if (gaps.length === 0) return "";
  const lines = gaps.map((g) => {
    const remediation = g.remediation === undefined ? "" : ` (${g.remediation})`;
    return `- ${g.detail}${remediation}`;
  });
  return ["", "## Gaps", "", ...lines, ""].join("\n");
}

export function renderLatency(ms: number): string {
  return `_generated in ${(ms / 1000).toFixed(1)} s_`;
}

/**
 * Assemble a brief: the header, then the body parts, then the reserved `## Gaps` block and the
 * latency footer — in that order, with empty parts dropped.
 *
 * The `""` between header and body is dropped by that same filter, so it produces NO blank line;
 * it is kept only because removing it would change nothing and this shape is what every renderer
 * already had. Spacing comes from the parts themselves — `renderGaps` opens with a newline, and
 * each section block carries its own — which is why `renderGhost` passing a bare one-line body
 * yields `# Ghost: …\n<body>` rather than a blank line between them. That is pre-existing
 * behaviour, byte-identical before and after this helper existed, and the brief snapshots pin it.
 *
 * ONE assembler for every brief that ends this way, and it is I31 machinery rather than
 * formatting sugar. `reserved()` is what WITHHOLDS a disclosure-only section from a synthesis
 * rewrite so `synthesize.ts` can re-attach it verbatim; a renderer that assembled its own tail is
 * a renderer that could forget to, or could order Gaps after the footer, and the guard in
 * `brief-contract.ts` would then be checking a document the renderer never promised. Keeping the
 * shape in one place is what makes "every brief ends with its Gaps, and honours `omitReserved`"
 * true by construction rather than by sixteen agreeing copies.
 *
 * Briefs with additional reserved sections of their own — `negotiate`'s `## Sources` and
 * `## Evidence not available from the index` — deliberately do NOT use this helper: their tail is
 * longer than "gaps then footer", and forcing them through here would mean a parameter for every
 * variation, which is how a shared assembler stops being one.
 */
export function assembleBrief(
  header: string,
  body: readonly string[],
  brief: { readonly gaps: GapNote[]; readonly latencyMs: number },
  opts: RenderOpts | undefined,
): string {
  const gaps = reserved(renderGaps(brief.gaps), opts);
  return [header, "", ...body, gaps, renderLatency(brief.latencyMs)]
    .filter((s) => s !== "")
    .join("\n");
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Minute precision, UTC, for standup entries.
 *
 * `isoDay` is wrong for this brief: the default window is 24 hours, so every entry would render
 * as one of two dates and the ordering the reader came for — what I did this morning versus last
 * night — would be invisible. Seconds are dropped as noise at this granularity.
 *
 * UTC rather than local time, and the `Z` says so. Local time would be friendlier to read and
 * would make the render non-deterministic across machines, which `nimbus fleet digest` compares
 * between runs — and a standup produced by an overnight fleet job on the same index would then
 * differ from the one the owner runs at their desk.
 */
export function isoMinuteUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** `noun` for exactly one, `noun` + "s" otherwise — regular plurals only. */
export function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}
