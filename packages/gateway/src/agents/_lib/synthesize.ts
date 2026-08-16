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
import type { SynthesisAttempt, SynthesisRunner } from "./synthesis-llm.ts";

export type SynthesizeOpts = {
  runner?: SynthesisRunner;
};

/**
 * Why a synthesized rewrite was — or was not — used, reported on the `briefReady` notification
 * (spec §2.7) so "why is my brief still deterministic?" is answerable without a debug build.
 *
 * `contract_violation` is a verdict `synthesize` reaches itself, AFTER the model's markdown
 * exists and has been checked against `contractViolations` (Task 2) — `SynthesisRunner.run`
 * (Task 4) never produces it, because the honesty contract is about what the MARKDOWN says, not
 * about whether the provider call itself succeeded.
 */
export type SynthesisProvenance =
  | { attempted: false; reason: "disabled" | "no_eligible_provider" }
  | { attempted: true; used: true; model: string; remote: boolean }
  | {
      attempted: true;
      used: false;
      reason: "timeout" | "contract_violation" | "egress_append_failed" | "provider_error";
      missingPhrases?: string[];
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
 * Label the no-synthesis path so it reads as a supported mode rather than breakage.
 *
 * Applies to EVERY path that ends up emitting the deterministic render: no runner configured
 * (`[agents].synthesis = "off"`), no eligible provider resolved, and every rejection reason a
 * used-but-unsuccessful synthesis attempt can report (`timeout`, `contract_violation`,
 * `egress_append_failed`, `provider_error`). Previously two of those fallback branches (a
 * null/empty result, a thrown error) returned the RAW deterministic render with no footer at
 * all — an inconsistency fixed here: every path that discards a synthesis, for whatever reason,
 * carries the same disclosure that no LLM output is being shown.
 *
 * A USED synthesis (`attempted: true, used: true`) gets a different footer instead — see
 * `withProvenanceFooter` — naming the model and whether it ran locally, because "built-in
 * briefs do not use an LLM" is false on that path.
 */
function withDeterministicFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${DETERMINISTIC_FOOTER}\n`;
}

/**
 * Footer for a synthesis that was actually used (passed the contract guard). Reuses the
 * `{model, remote}` provenance shape §2.5 of the design doc calls out — the same shape the
 * research-briefs surface (`briefs/brief-synthesis.ts`) already established for its own
 * disclosure — rather than inventing a second vocabulary for the same fact.
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
  const footeredDeterministic = withDeterministicFooter(deterministic);

  if (opts.runner === undefined) {
    return {
      markdown: footeredDeterministic,
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

  const attempt: SynthesisAttempt = await opts.runner.run(prompt);

  if (!attempt.ok) {
    if (attempt.reason === "no_eligible_provider") {
      return {
        markdown: footeredDeterministic,
        provenance: { attempted: false, reason: "no_eligible_provider" },
      };
    }
    return {
      markdown: footeredDeterministic,
      provenance: {
        attempted: true,
        used: false,
        reason: attempt.reason,
        ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
      },
    };
  }

  const violations = contractViolations(brief, attempt.markdown);
  if (violations.length > 0) {
    return {
      markdown: footeredDeterministic,
      provenance: {
        attempted: true,
        used: false,
        reason: "contract_violation",
        missingPhrases: violations,
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
