import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
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
import {
  renderCatchup,
  renderConflict,
  renderExpert,
  renderGhost,
  renderHuddle,
  renderImpact,
  renderJanitor,
  renderPreflight,
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
  | WhyBrief;

function deterministicRender(brief: SynthInput): string {
  if (brief.kind === "expert") return renderExpert(brief);
  if (brief.kind === "impact") return renderImpact(brief);
  if (brief.kind === "catchup") return renderCatchup(brief);
  if (brief.kind === "ghost") return renderGhost(brief);
  if (brief.kind === "conflict") return renderConflict(brief);
  if (brief.kind === "janitor") return renderJanitor(brief);
  if (brief.kind === "preflight") return renderPreflight(brief);
  if (brief.kind === "why") return renderWhy(brief);
  return renderHuddle(brief);
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
  return "agents.huddle";
}

export async function synthesize(brief: SynthInput, opts: SynthesizeOpts = {}): Promise<string> {
  const deterministic = deterministicRender(brief);
  if (opts.llm === undefined) return deterministic;

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
