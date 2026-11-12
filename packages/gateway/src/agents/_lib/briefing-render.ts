import type {
  BriefingBrief,
  BriefingRow,
  BriefingSectionBlock,
  FreshnessRow,
  RowPart,
} from "./briefing-types.ts";
import { hardenedPlain, hardenedTitleLink, type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of the morning briefing (OR-10-8: no model anywhere in it). Zone-free: every
 * time in the brief is already a label. Indexed text is hardened here and only here: a title through
 * `hardenedTitleLink`, any other indexed text through `hardenedPlain` (line structure stripped, capped
 * at 80 characters, brackets escaped).
 */
export const BRIEFING_FRESHNESS_HEADING = "## Data freshness";

function renderPart(p: RowPart): string {
  switch (p.t) {
    case "text":
      return p.text;
    case "link":
      return hardenedTitleLink(p.title, p.url);
    case "plain":
      return hardenedPlain(p.text);
  }
}

function renderRow(row: BriefingRow): string {
  return `- ${row.map(renderPart).join("")}`;
}

function renderBlock(b: BriefingSectionBlock): string {
  const lines = [`## ${b.title}`, ""];
  if (b.rows.length > 0) lines.push(...b.rows.map(renderRow));
  if (b.emptyText !== null) lines.push(`_${b.emptyText}_`);
  for (const n of b.notes) lines.push(`_${n}_`);
  return lines.join("\n");
}

/** The reserved `## Data freshness` block, built from the brief's own rows ("" when it has none). */
export function renderBriefingFreshness(rows: readonly FreshnessRow[]): string {
  if (rows.length === 0) return "";
  return [BRIEFING_FRESHNESS_HEADING, "", ...rows.map((r) => `- ${r.section}: ${r.text}`)].join(
    "\n",
  );
}

export function renderBriefing(brief: BriefingBrief, opts?: RenderOpts): string {
  const header = `# Morning briefing - ${brief.day.label} (${brief.tz})`;
  const body = brief.sections.map(renderBlock);
  const withheld = opts?.omitReserved === true;
  const gaps = withheld ? "" : renderGaps(brief.gaps).trim();
  const freshness = withheld ? "" : renderBriefingFreshness(brief.freshness);
  return [header, ...body, gaps, freshness].filter((s) => s !== "").join("\n\n");
}
