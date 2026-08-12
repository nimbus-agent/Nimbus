import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import type { DecisionsBrief } from "./decisions-types.ts";
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
} from "./findings.ts";
import type { GlossaryBrief } from "./glossary-types.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import type { OwnershipBrief } from "./ownership-types.ts";
import type { PremortemBrief } from "./premortem-types.ts";
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
import type { WhyBrief } from "./why-types.ts";

export type SynthesizerLlm = {
  generateMarkdown: (prompt: string) => Promise<string | null>;
};

export type SynthesizeOpts = {
  llm?: SynthesizerLlm;
};

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

type SynthInput =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief
  | JanitorBrief
  | PreflightBrief
  | WhyBrief
  | GlossaryBrief
  | DecisionsBrief
  | OwnershipBrief
  | PremortemBrief
  | NegotiateBrief;

/**
 * Turns a missing dispatch arm into a COMPILE error.
 *
 * Both dispatches below previously ended in a bare `return renderHuddle(brief)` /
 * `return "agents.huddle"`. Extending `SynthInput` without extending them therefore
 * compiled, ran, and rendered the new brief as a huddle — reporting itself to the model
 * as `agents.huddle` into the bargain. Nothing failed. Every member of the union carries
 * a distinct `kind` literal, so this guard is a genuine exhaustiveness check.
 *
 * The runtime throw is unreachable while the union and the arms agree, and is safe if it
 * ever is not: `synthesize` is awaited inside `emitBriefWithSynthesis`'s async IIFE, whose
 * `.catch` emits `<agent>.briefError`. A named error beats a plausible wrong answer.
 */
function assertNeverBrief(x: never): never {
  const kind = (x as { kind?: unknown }).kind;
  throw new Error(`synthesize: unhandled brief kind ${String(kind)}`);
}

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

const DETERMINISTIC_FOOTER = "_Rendered deterministically — configure an LLM for prose synthesis._";

/**
 * Label the no-LLM path so it reads as a supported mode rather than breakage.
 *
 * The fallback branches below (empty / throwing LLM) deliberately do NOT get
 * this footer: there the user HAS configured an LLM, and telling them to
 * configure one would send them to fix a setting that is already correct.
 */
function withDeterministicFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${DETERMINISTIC_FOOTER}\n`;
}

export async function synthesize(brief: SynthInput, opts: SynthesizeOpts = {}): Promise<string> {
  const deterministic = deterministicRender(brief);
  if (opts.llm === undefined) return withDeterministicFooter(deterministic);

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

  try {
    const out = await opts.llm.generateMarkdown(prompt);
    if (out === null || out.trim().length === 0) return deterministic;
    return out;
  } catch {
    return deterministic;
  }
}
