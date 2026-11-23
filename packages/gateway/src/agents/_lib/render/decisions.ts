import type { DecisionEvidence } from "../../../decisions/decision-types.ts";
import { decisionsAgentDisclosure } from "../brief-disclosures.ts";
import type { DecisionsBrief, DecisionsEntry } from "../decisions-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { assembleBrief, isoDay } from "./_shared.ts";

const DECISIONS_EVIDENCE_PREFIX: Readonly<Record<DecisionEvidence["kind"], string>> = Object.freeze(
  {
    source: "",
    pr: "PR",
    commit: "commit",
    migration: "migration",
    iac: "IaC",
    adr: "ADR",
  },
);

/**
 * Evidence renders as a Markdown link whenever the corroborating item carried a
 * `url` — the same `[text](url)` shape the why/glossary renderers above use.
 * `url` is nullable (a graph entity with no indexed permalink), and a bare
 * `[label]()` would render as a dead link, so the unlinked form stays the
 * fallback rather than an empty target.
 */
function renderDecisionsEvidenceItem(e: DecisionEvidence): string {
  const prefix = DECISIONS_EVIDENCE_PREFIX[e.kind];
  const text = prefix === "" ? e.label : `${prefix} ${e.label}`;
  return e.url === null ? text : `[${text}](${e.url})`;
}

/** Days between the brief's generation time and the `--since` cutoff, for the heading. */
function decisionsWindowDays(generatedAt: number, sinceMs: number): number {
  return Math.max(0, Math.round((generatedAt - sinceMs) / 86_400_000));
}

function renderDecisionsExplain(e: DecisionsEntry): string[] {
  if (e.explain.length === 0) return [];
  const rows = e.explain.map((t) => `        - ${t.term} (${t.value.toFixed(2)}): ${t.detail}`);
  return ["      confidence breakdown:", ...rows];
}

function renderDecisionsEntry(brief: DecisionsBrief, e: DecisionsEntry): string {
  const lines = [`${e.confidence.toFixed(2)}  ${e.statement}  ${isoDay(e.decidedAt)}`];
  if (e.extractionSource === "agent") lines.push(decisionsAgentDisclosure().line);
  if (!e.hasAdr) lines.push("      ⚠ no ADR found");
  if (e.rationale !== null) lines.push(`      rationale     ${e.rationale}`);
  if (e.alternatives.length > 0) {
    lines.push(`      alternatives  ${e.alternatives.join(" · ")}`);
  }
  if (e.evidence.length > 0) {
    lines.push(`      evidence      ${e.evidence.map(renderDecisionsEvidenceItem).join(" · ")}`);
  }
  if (brief.query.explain) lines.push(...renderDecisionsExplain(e));
  return lines.join("\n");
}

export function renderDecisions(brief: DecisionsBrief, opts?: RenderOpts): string {
  const days = decisionsWindowDays(brief.generatedAt, brief.query.sinceMs);
  const header = `## Decisions · ${String(days)}d · ${String(brief.entries.length)} found`;
  const body =
    brief.entries.length === 0
      ? "_No decisions found._"
      : brief.entries.map((e) => renderDecisionsEntry(brief, e)).join("\n\n");
  return assembleBrief(header, [body], brief, opts);
}
