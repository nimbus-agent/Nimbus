import {
  type IncidentPostmortemBrief,
  POSTMORTEM_SECTION_IDS,
  type PostmortemAction,
  type PostmortemSectionId,
  type PostmortemTemplate,
} from "./incident-postmortem-types.ts";
import {
  changeLines,
  concurrentLines,
  priorLines,
  renderIncidentFreshness,
  serviceLines,
  summaryLines,
  utcLabel,
  utcSecondsLabel,
} from "./incident-render.ts";
import { hardenedPlain, type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of a post-mortem draft (Phase 10 IC7a; OR-10-8: no model anywhere in it). Zone-free
 * (every time is UTC) and clock-free (no generation time is printed), so two renders of the same record version
 * are byte-identical. Every provider-supplied string goes through `hardenedPlain` or the incident renderer's own
 * helpers; fixed text is ours.
 *
 * Wording follows D-IC-2: the change lane is "Candidate causes", every entry is a candidate with its timing and
 * rule, and the words "root cause" appear only in the owner's placeholder. IC5 (proposals) and IC6 (runbook
 * steps) are not part of this version, so the Action items section is placeholders and says so.
 *
 * Reserved for I31: `## Timeline`, `## Decision log`, `## Gaps` and `## Data freshness`. A template can omit
 * the first two (it is the owner's document) but can never drop the last two.
 */

export const POSTMORTEM_TIMELINE_HEADING = "## Timeline";
export const POSTMORTEM_DECISION_LOG_HEADING = "## Decision log";
export const POSTMORTEM_PLACEHOLDER = "_To be completed by the owner._";

const TEMPLATE_MAX_BYTES = 64 * 1024;
const PLAIN_MAX = 120;
const PROMPT_LINES_MAX = 14;
const PROMPT_LINE_MAX = 200;

const plain = (s: string): string => hardenedPlain(s, PLAIN_MAX);

export class PostmortemTemplateError extends Error {
  readonly code = "ERR_POSTMORTEM_TEMPLATE";
  constructor(message: string) {
    super(`ERR_POSTMORTEM_TEMPLATE: ${message}`);
    this.name = "PostmortemTemplateError";
  }
}

// Controls, format characters (bidi, zero-width, BOM) and line or paragraph separators. TAB and LF are
// removed from the text before this test; a CR left after CRLF normalisation is refused.
const TEMPLATE_BAD_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.codePointAt(i) === 10) line += 1;
  return line;
}

function assertTemplateText(text: string): void {
  if (new TextEncoder().encode(text).length > TEMPLATE_MAX_BYTES) {
    throw new PostmortemTemplateError("the template is larger than 64 KiB");
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = (lines[i] as string).replaceAll("\t", " ");
    if (TEMPLATE_BAD_CHAR_RE.test(stripped)) {
      throw new PostmortemTemplateError(
        `line ${String(i + 1)} holds a control or invisible character`,
      );
    }
  }
}

/** Parses a template file's text. Throws {@link PostmortemTemplateError}; the message never echoes the file. */
export function parsePostmortemTemplate(raw: string): PostmortemTemplate {
  const text = raw.replaceAll("\r\n", "\n");
  assertTemplateText(text);
  const out: PostmortemTemplate["parts"][number][] = [];
  const seen = new Set<PostmortemSectionId>();
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("{{", at);
    if (open === -1) {
      out.push({ kind: "text", text: text.slice(at) });
      break;
    }
    const close = text.indexOf("}}", open + 2);
    if (close === -1) {
      throw new PostmortemTemplateError(`line ${String(lineOf(text, open))} has an unclosed "{{"`);
    }
    const name = text.slice(open + 2, close).trim();
    const id = (POSTMORTEM_SECTION_IDS as readonly string[]).includes(name)
      ? (name as PostmortemSectionId)
      : undefined;
    if (id === undefined) {
      throw new PostmortemTemplateError(
        `line ${String(lineOf(text, open))} names an unknown placeholder; the placeholders are ${POSTMORTEM_SECTION_IDS.join(", ")}`,
      );
    }
    if (seen.has(id)) {
      throw new PostmortemTemplateError(
        `line ${String(lineOf(text, open))} repeats the placeholder ${id}`,
      );
    }
    seen.add(id);
    if (open > at) out.push({ kind: "text", text: text.slice(at, open) });
    out.push({ kind: "section", id });
    at = close + 2;
  }
  return { parts: out };
}

const DEFAULT_TEMPLATE: PostmortemTemplate = {
  parts: POSTMORTEM_SECTION_IDS.flatMap((id, i) => [
    ...(i === 0 ? [] : [{ kind: "text" as const, text: "\n\n" }]),
    { kind: "section" as const, id },
  ]),
};

function block(heading: string, lines: readonly string[]): string {
  return [heading, "", ...lines].join("\n");
}

function summarySection(b: IncidentPostmortemBrief): string {
  return block("## Summary", [...summaryLines(b.record.trigger), ...serviceLines(b.record)]);
}

function durationText(openedMs: number, resolvedMs: number): string {
  const minutes = Math.floor((resolvedMs - openedMs) / 60_000);
  if (minutes < 0) return "not computed (the resolution is earlier than the open time)";
  if (minutes < 120) return `${String(minutes)} min`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

function impactSection(b: IncidentPostmortemBrief): string {
  const i = b.impact;
  const lines = [
    i.openedMs === null
      ? "- Opened: not recorded by the source"
      : `- Opened: ${utcLabel(i.openedMs)} (${i.openedBasis})`,
    i.resolvedMs === null
      ? "- Resolved: time not recorded"
      : `- Resolved: ${utcLabel(i.resolvedMs)} (${i.resolvedBasis})`,
  ];
  if (i.openedMs !== null && i.resolvedMs !== null) {
    lines.push(`- Duration: ${durationText(i.openedMs, i.resolvedMs)}`);
  }
  return block("## Impact window", lines);
}

function timelineSection(b: IncidentPostmortemBrief): string {
  const events =
    b.timeline.events.length === 0
      ? ["_No event to show._"]
      : b.timeline.events.map(
          (e) => `- ${utcSecondsLabel(e.atMs)} (${e.atBasis}) ${e.kind}: ${plain(e.text)}`,
        );
  return block(POSTMORTEM_TIMELINE_HEADING, [
    ...events,
    ...b.timeline.notes.map((n) => `_Note: ${plain(n)}_`),
  ]);
}

function candidateSection(b: IncidentPostmortemBrief): string {
  return block("## Candidate causes", [
    "_Candidates from the index, for the owner to confirm or discard. None is a proven cause._",
    "",
    ...changeLines(b.record.change),
    "",
    `- Root cause: ${POSTMORTEM_PLACEHOLDER}`,
  ]);
}

function factorsSection(b: IncidentPostmortemBrief): string {
  return block("## Contributing factors", [
    "Other records open within 30 minutes:",
    "",
    ...concurrentLines(b.record.concurrent),
    "",
    "Earlier incidents on this service:",
    "",
    ...priorLines(b.record.prior),
    "",
    `- Other factors: ${POSTMORTEM_PLACEHOLDER}`,
  ]);
}

function actionLine(a: PostmortemAction): string {
  const how = a.answerSource === undefined ? "" : ` (answered by ${plain(a.answerSource)})`;
  const reads =
    a.subSteps === 0 ? "" : `, ${String(a.subSteps)} read${a.subSteps === 1 ? "" : "s"}`;
  return `- ${utcSecondsLabel(a.timestamp)}: ${plain(a.actionType)} ${a.verdict}${how}${reads}`;
}

function whatWeDidSection(b: IncidentPostmortemBrief): string {
  const lines =
    b.actions.length === 0
      ? ["_No Nimbus action was linked to this record._"]
      : b.actions.map(actionLine);
  if (b.actionsTruncated) {
    lines.push("_More linked actions exist than were read; the first 5,000 audit rows are shown._");
  }
  return block("## What we did", [
    ...lines,
    "",
    "_Actions taken outside Nimbus are not recorded here._",
    `- Outside Nimbus: ${POSTMORTEM_PLACEHOLDER}`,
  ]);
}

function actionItemsSection(): string {
  return block("## Action items", [
    `- ${POSTMORTEM_PLACEHOLDER}`,
    "",
    "_Not available in this version: undone runbook checks and open remediation proposals are not listed here._",
  ]);
}

function promptLines(a: PostmortemAction): string[] {
  if (a.prompt === null) return ["  _The audit row kept no prompt._"];
  const all = a.prompt.text.split("\n");
  const lines = all
    .slice(0, PROMPT_LINES_MAX)
    .map((l) => `  > ${hardenedPlain(l, PROMPT_LINE_MAX)}`);
  if (a.prompt.cut || all.length > PROMPT_LINES_MAX) lines.push("  > _(cut)_");
  return [`  Prompt shown (sha256 ${a.prompt.sha256.slice(0, 12)}):`, ...lines];
}

function decisionLogSection(b: IncidentPostmortemBrief): string {
  const entries =
    b.actions.length === 0
      ? ["_No Nimbus action was linked to this record._"]
      : b.actions.flatMap((a) => [
          `- audit #${String(a.auditId)}, ${utcSecondsLabel(a.timestamp)}: ${plain(a.actionType)}, decision ${a.verdict}${a.answerSource === undefined ? "" : `, answered by ${plain(a.answerSource)}`}, record version ${String(a.linkVersion)}`,
          ...promptLines(a),
        ]);
  return block(POSTMORTEM_DECISION_LOG_HEADING, [
    ...entries,
    "",
    "_The audit row records the decision, not the dispatch result._",
  ]);
}

const SECTION_RENDERERS: Readonly<
  Record<PostmortemSectionId, (b: IncidentPostmortemBrief) => string>
> = {
  summary: summarySection,
  impact_window: impactSection,
  timeline: timelineSection,
  candidate_causes: candidateSection,
  contributing_factors: factorsSection,
  what_we_did: whatWeDidSection,
  action_items: actionItemsSection,
  decision_log: decisionLogSection,
};

const RESERVED_SECTIONS: ReadonlySet<PostmortemSectionId> = new Set(["timeline", "decision_log"]);

/**
 * The reserved sections a brief's template places (I31). Built from the brief, never recovered by parsing the
 * render. A template that omits `{{timeline}}` or `{{decision_log}}` has no such block to reserve.
 */
export function postmortemReservedBlocks(
  b: IncidentPostmortemBrief,
): { readonly heading: string; readonly markdown: string }[] {
  const parts = (b.template ?? DEFAULT_TEMPLATE).parts;
  const placed = new Set(parts.flatMap((p) => (p.kind === "section" ? [p.id] : [])));
  const out: { heading: string; markdown: string }[] = [];
  if (placed.has("timeline")) {
    out.push({ heading: POSTMORTEM_TIMELINE_HEADING, markdown: timelineSection(b) });
  }
  if (placed.has("decision_log")) {
    out.push({ heading: POSTMORTEM_DECISION_LOG_HEADING, markdown: decisionLogSection(b) });
  }
  return out;
}

export function renderIncidentPostmortem(
  brief: IncidentPostmortemBrief,
  opts?: RenderOpts,
): string {
  const withheld = opts?.omitReserved === true;
  const template = brief.template ?? DEFAULT_TEMPLATE;
  const body = template.parts
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (withheld && RESERVED_SECTIONS.has(p.id)) return "";
      return SECTION_RENDERERS[p.id](brief);
    })
    .join("")
    .trim();
  const header = `# Post-mortem: ${plain(brief.record.trigger.title)}`;
  const gaps = withheld ? "" : renderGaps(brief.gaps).trim();
  const freshness = withheld ? "" : renderIncidentFreshness(brief.record.freshness);
  return [header, body, gaps, freshness].filter((s) => s !== "").join("\n\n");
}
