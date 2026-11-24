import type { SynthesisDiscardReason } from "./synthesize.ts";

/**
 * The footers `synthesize()` appends to a deterministic render, split out of `synthesize.ts` (a file-size
 * baseline file) unchanged. Each names ONE distinct situation; conflating them was a real defect (I2).
 */

const DETERMINISTIC_FOOTER =
  "_Rendered deterministically — built-in briefs do not use an LLM, regardless of `[llm]` settings._";

/**
 * Label the fully-unattempted path (no runner at all — `opts.runner === undefined`, which is
 * `[agents].synthesis = "off"` or an embedded/test caller with no LLM registry wired) so it reads
 * as a supported mode rather than breakage. `"regardless of \`[llm]\` settings"` is true only
 * here: `"off"` disables synthesis no matter what `[llm]` says, so naming that knob as irrelevant
 * is accurate. It must NEVER be emitted once a runner was actually called — see
 * `withDiscardedSynthesisFooter` for that case, and `withNoEligibleProviderFooter` for the
 * runner-was-invoked-but-nothing-resolved case, which this clause would misdirect on (below).
 * Conflating any of these was a real defect caught in review (I2): a remote provider can be
 * called, and its egress row appended to the ledger, on a request whose synthesis is later
 * discarded (timeout, contract violation, ...) — labelling that brief "does not use an LLM" would
 * contradict what `nimbus prove` shows for the same request.
 */
export function withDeterministicFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${DETERMINISTIC_FOOTER}\n`;
}

const NO_ELIGIBLE_PROVIDER_FOOTER =
  "_Rendered deterministically — no eligible LLM provider was available for this brief. Depends on both `[llm]` (whether a provider is configured and reachable) and `[agents] synthesis` (whether it may be used here)._";

/**
 * Label the case where a runner WAS invoked (`[agents].synthesis` is `"local"` or
 * `"allow-remote"`) but resolution itself came back empty — the router had no local provider, or
 * `"local"` mode refused a remote-only resolution. Distinct from `withDeterministicFooter`
 * because `"regardless of \`[llm]\` settings"` is false here: under `"local"`/`"allow-remote"`,
 * `[llm]` settings (is Ollama running, is a key set) are typically the ANSWER to why nothing
 * resolved, not an irrelevant knob. Does not promise that fixing `[llm]` will make synthesis run
 * — `[agents] synthesis` independently governs it — so it names both rather than pointing at one.
 */
export function withNoEligibleProviderFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${NO_ELIGIBLE_PROVIDER_FOOTER}\n`;
}

/**
 * Plain-language reason a called-but-discarded synthesis was thrown away. Kept separate from
 * `SynthesisProvenance.reason` (the machine-readable value) so the footer text can change
 * independently of the wire contract.
 */
const DISCARD_REASON_LABELS: Record<SynthesisDiscardReason, string> = {
  timeout: "the synthesis timed out",
  provider_error: "the provider returned an error",
  egress_append_failed: "the egress ledger could not be updated",
  contract_violation: "the rewrite dropped a required disclosure",
  empty_result: "the provider returned no usable text",
};

/**
 * Footer for every path where a runner WAS invoked and its output was discarded: `timeout`,
 * `provider_error`, `egress_append_failed`, `contract_violation`, `empty_result`. Unlike
 * `DETERMINISTIC_FOOTER`, this does not claim "briefs do not use an LLM" — an LLM call may well
 * have happened (and, for a remote provider, been ledgered) — it states that this brief is the
 * deterministic rendering AND names why the attempted rewrite was not used.
 */
export function withDiscardedSynthesisFooter(
  markdown: string,
  reason: SynthesisDiscardReason,
): string {
  const label = DISCARD_REASON_LABELS[reason];
  return `${markdown.trimEnd()}\n\n_Rendered deterministically — a synthesis was attempted and discarded (${label})._\n`;
}

/**
 * Footer for a synthesis that was actually used (passed the empty-result and contract guards).
 * Reuses the `{model, remote}` provenance shape §2.5 of the design doc calls out — the same
 * shape the research-briefs surface (`briefs/brief-synthesis.ts`) already established for its
 * own disclosure — rather than inventing a second vocabulary for the same fact.
 */
export function withProvenanceFooter(markdown: string, model: string, remote: boolean): string {
  const locality = remote ? "remote" : "local";
  return `${markdown.trimEnd()}\n\n_Synthesized by ${model} (${locality})._\n`;
}

const RESERVED_EXTRACTION_FAILED_FOOTER =
  "_Rendered deterministically — the brief's reserved disclosure sections could not be isolated, so no rewrite was attempted._";

/**
 * Label the case where a renderer did not honour `omitReserved` — a new brief kind, or a new
 * disclosure section added to an existing renderer without routing it through the flag. The
 * reserved content would otherwise have gone to the model unguarded while everything looked
 * healthy, so this path fails closed and says so. Distinct from every other footer for the
 * reason recorded on `withDeterministicFooter`: conflating these was a real defect once.
 */
export function withReservedExtractionFailedFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${RESERVED_EXTRACTION_FAILED_FOOTER}\n`;
}
