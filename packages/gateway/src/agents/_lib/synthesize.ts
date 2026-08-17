import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import { contractViolations } from "./brief-contract.ts";
import { assertNeverBrief, type SynthInput } from "./brief-kinds.ts";
import {
  renderCatchup,
  renderConflict,
  renderDecisions,
  renderExpert,
  renderGhost,
  renderGlossary,
  renderHuddle,
  renderImpact,
  renderJanitor,
  renderNegotiate,
  renderOwnership,
  renderPreflight,
  renderPremortem,
  renderWhy,
} from "./render.ts";
import {
  redactedErrorDetail,
  type SynthesisAttempt,
  type SynthesisRunner,
} from "./synthesis-llm.ts";

export type SynthesizeOpts = {
  runner?: SynthesisRunner;
};

/** Every reason a synthesis attempt can be discarded once a runner was actually invoked. */
export type SynthesisDiscardReason =
  | "timeout"
  | "contract_violation"
  | "egress_append_failed"
  | "provider_error"
  | "empty_result";

/**
 * Why a synthesized rewrite was — or was not — used, reported on the `briefReady` notification
 * (spec §2.7) so "why is my brief still deterministic?" is answerable without a debug build.
 *
 * `contract_violation` is a verdict `synthesize` reaches itself, AFTER the model's markdown
 * exists and has been checked against `contractViolations` (Task 2) — `SynthesisRunner.run`
 * (Task 4) never produces it, because the honesty contract is about what the MARKDOWN says, not
 * about whether the provider call itself succeeded. `empty_result` is likewise a `synthesize`
 * verdict, not a `SynthesisAttempt` reason: a provider can return `ok: true` with empty text
 * (`llm/ollama-provider.ts:142` deliberately returns `""` on an unexpected response body, and
 * `LlmRouter.generateMarkdown` passes that through with no guard), which is a well-formed
 * `SynthesisAttempt` that still must not reach the reader as a brief.
 */
export type SynthesisProvenance =
  | { attempted: false; reason: "disabled" | "no_eligible_provider" }
  | { attempted: true; used: true; model: string; remote: boolean }
  | {
      attempted: true;
      used: false;
      reason: SynthesisDiscardReason;
      /** Sentences from `contractViolations` — set only when `reason` is `contract_violation`. */
      violations?: string[];
      /**
       * Redacted (by `synthesis-llm.ts`'s `redactedErrorDetail`) before it ever reaches this
       * type — never populate this field from a raw, un-redacted error message.
       */
      detail?: string;
    };

export type SynthesisOutcome = { markdown: string; provenance: SynthesisProvenance };

function deterministicRender(brief: SynthInput): string {
  if (brief.kind === "expert") return renderExpert(brief);
  if (brief.kind === "impact") return renderImpact(brief);
  if (brief.kind === "catchup") return renderCatchup(brief);
  if (brief.kind === "ghost") return renderGhost(brief);
  if (brief.kind === "conflict") return renderConflict(brief);
  if (brief.kind === "janitor") return renderJanitor(brief);
  if (brief.kind === "preflight") return renderPreflight(brief);
  if (brief.kind === "why") return renderWhy(brief);
  if (brief.kind === "glossary") return renderGlossary(brief);
  if (brief.kind === "decisions") return renderDecisions(brief);
  if (brief.kind === "ownership") return renderOwnership(brief);
  if (brief.kind === "huddle") return renderHuddle(brief);
  if (brief.kind === "premortem") return renderPremortem(brief);
  if (brief.kind === "negotiate") return renderNegotiate(brief);
  return assertNeverBrief(brief);
}

function toolNameFor(brief: SynthInput): string {
  if (brief.kind === "expert") return "agents.expert";
  if (brief.kind === "impact") return "agents.impact";
  if (brief.kind === "catchup") return "agents.catchup";
  if (brief.kind === "ghost") return "agents.ghost";
  if (brief.kind === "conflict") return "agents.conflicts";
  if (brief.kind === "janitor") return "agents.janitor";
  if (brief.kind === "preflight") return "agents.preflight";
  if (brief.kind === "why") return "agents.why";
  if (brief.kind === "glossary") return "agents.glossary";
  if (brief.kind === "decisions") return "agents.decisions";
  if (brief.kind === "ownership") return "agents.ownership";
  if (brief.kind === "huddle") return "agents.huddle";
  if (brief.kind === "premortem") return "agents.premortem";
  if (brief.kind === "negotiate") return "agents.negotiate";
  return assertNeverBrief(brief);
}

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
function withDeterministicFooter(markdown: string): string {
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
function withNoEligibleProviderFooter(markdown: string): string {
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
function withDiscardedSynthesisFooter(markdown: string, reason: SynthesisDiscardReason): string {
  const label = DISCARD_REASON_LABELS[reason];
  return `${markdown.trimEnd()}\n\n_Rendered deterministically — a synthesis was attempted and discarded (${label})._\n`;
}

/**
 * Footer for a synthesis that was actually used (passed the empty-result and contract guards).
 * Reuses the `{model, remote}` provenance shape §2.5 of the design doc calls out — the same
 * shape the research-briefs surface (`briefs/brief-synthesis.ts`) already established for its
 * own disclosure — rather than inventing a second vocabulary for the same fact.
 */
function withProvenanceFooter(markdown: string, model: string, remote: boolean): string {
  const locality = remote ? "remote" : "local";
  return `${markdown.trimEnd()}\n\n_Synthesized by ${model} (${locality})._\n`;
}

export async function synthesize(
  brief: SynthInput,
  opts: SynthesizeOpts = {},
): Promise<SynthesisOutcome> {
  const deterministic = deterministicRender(brief);

  if (opts.runner === undefined) {
    return {
      markdown: withDeterministicFooter(deterministic),
      provenance: { attempted: false, reason: "disabled" },
    };
  }

  const wrapped = wrapToolOutput({ service: "nimbus", tool: toolNameFor(brief) }, brief);
  const prompt = [
    SYNTHESIS_INSTRUCTIONS,
    "",
    "Findings:",
    wrapped,
    "",
    "Deterministic fallback rendering (use as a structural template — do not copy verbatim):",
    deterministic,
  ].join("\n");

  // A REJECTING runner degrades to the deterministic brief, exactly like a runner that returns
  // `ok: false`. Without this catch the rejection propagates out of `synthesize()` and
  // `emitBriefWithSynthesis` emits `briefError` — the reader gets NO brief at all because an
  // optional rewrite failed, inverting the rule that synthesis is best-effort and the
  // deterministic render is the floor. The production runner does not catch every path:
  // `buildSynthesisRunner` awaits `router.resolveForSynthesis(true)` outside its own try, so a
  // provider-registry or network fault during RESOLUTION rejects here (generation failures
  // already come back as the `provider_error` reason rather than a rejection). Classified as
  // `provider_error` because that is what it is — the provider side failed, and it is not the
  // `timeout` race. `redactedErrorDetail` — the SAME scrubber the runner's own failure branches
  // use — keeps a raw error message out of `detail`, which travels to the reader on `briefReady`.
  let attempt: SynthesisAttempt;
  try {
    attempt = await opts.runner.run(prompt);
  } catch (err) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "provider_error"),
      provenance: {
        attempted: true,
        used: false,
        reason: "provider_error",
        detail: redactedErrorDetail(err),
      },
    };
  }

  if (!attempt.ok) {
    if (attempt.reason === "no_eligible_provider") {
      return {
        markdown: withNoEligibleProviderFooter(deterministic),
        provenance: { attempted: false, reason: "no_eligible_provider" },
      };
    }
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, attempt.reason),
      provenance: {
        attempted: true,
        used: false,
        reason: attempt.reason,
        ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
      },
    };
  }

  // A provider can answer `ok: true` with nothing usable — `llm/ollama-provider.ts:142`
  // deliberately returns `""` on an unexpected response body, and `LlmRouter.generateMarkdown`
  // passes that through unguarded. Whitespace-only counts too: it renders as a blank brief just
  // the same. Checked BEFORE the contract guard, because `contractViolations(brief, "")` returns
  // `[]` for any brief with no required phrases (13 of 14 agent kinds, and `negotiate` whenever
  // no lane is null) — an empty string would otherwise fall through as an "accepted" synthesis
  // and replace the entire deterministic finding set with nothing but a footer.
  if (attempt.markdown.trim().length === 0) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "empty_result"),
      provenance: { attempted: true, used: false, reason: "empty_result" },
    };
  }

  const violations = contractViolations(brief, attempt.markdown);
  if (violations.length > 0) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "contract_violation"),
      provenance: {
        attempted: true,
        used: false,
        reason: "contract_violation",
        violations,
      },
    };
  }

  return {
    markdown: withProvenanceFooter(attempt.markdown, attempt.model, attempt.remote),
    provenance: { attempted: true, used: true, model: attempt.model, remote: attempt.remote },
  };
}

const SYNTHESIS_INSTRUCTIONS = [
  "You are presenting structured findings from a Nimbus built-in agent.",
  "Rewrite the deterministic Markdown into a more readable brief.",
  "Rules:",
  "- Never invent evidence rows; only paraphrase or reorder what is already in the JSON.",
  "- Keep all section headings.",
  "- For each GapNote, include its `remediation` field if present, in plain English.",
  "- If the JSON contains zero ranked findings, say so plainly; do not pad.",
  "- Output Markdown only — no preamble, no code fences around the whole answer.",
].join("\n");
