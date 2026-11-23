import { glossaryProvenanceDisclosure } from "../brief-disclosures.ts";
import type { GlossaryBrief, GlossaryEntry } from "../glossary-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { isoDay, renderGaps, renderLatency, reserved } from "./_shared.ts";

/** `miss` mode: the term is unknown, so all we can offer are near-miss suggestions. */
function renderGlossaryMiss(brief: GlossaryBrief): string[] {
  const lines = [`\n_No glossary entry for \`${brief.query.term ?? ""}\`._`];
  if (brief.suggestions.length > 0) {
    lines.push(`\n**Did you mean:** ${brief.suggestions.join(", ")}`);
  }
  return lines;
}

/**
 * Labels a definition that was not synthesized by an LLM, so the reader can weigh it.
 * The sentences live in `brief-disclosures.ts`, which is also what the synthesis contract
 * guard requires to survive a rewrite — one definition, not two.
 */
function renderGlossaryProvenance(
  term: string,
  source: GlossaryEntry["definitionSource"],
): string[] {
  const provenance = glossaryProvenanceDisclosure(term, source);
  return provenance === undefined ? [] : [provenance.line];
}

function renderGlossarySources(sources: GlossaryEntry["topSources"]): string[] {
  if (sources.length === 0) return [];
  const rows = sources.map((s) => {
    const head = s.url === null ? s.title : `[${s.title}](${s.url})`;
    return `- ${head} — ${s.service}, ${isoDay(s.modifiedAt)}`;
  });
  return ["\n### Sources", ...rows];
}

/** `term` mode: the full record for a single resolved entry. */
function renderGlossaryEntry(brief: GlossaryBrief, e: GlossaryEntry): string[] {
  const lines = [`\n## ${e.term}`];
  if (brief.matchedVia === "synonym") {
    lines.push(`_Matched via synonym "${brief.query.term ?? ""}"._`);
  }
  lines.push(
    `\n${e.definition ?? "_No definition yet._"}`,
    `\n- Seen in ${String(e.docFreq)} item(s) across ${String(e.serviceSpread)} service(s)`,
    `- First seen ${isoDay(e.firstSeenAt)}, last seen ${isoDay(e.lastSeenAt)}`,
  );
  if (e.synonyms.length > 0) lines.push(`- Also known as: ${e.synonyms.join(", ")}`);
  if (e.nearMisses.length > 0) lines.push(`- Easily confused with: ${e.nearMisses.join(", ")}`);
  lines.push(
    ...renderGlossaryProvenance(e.term, e.definitionSource),
    ...renderGlossarySources(e.topSources),
  );
  return lines;
}

/**
 * `list` mode's entry table — a RESERVED section (F31a).
 *
 * Exported because `reserved-sections.ts` builds the withheld block from the SAME function the
 * renderer uses, never by scanning rendered markdown. The `## Terms` heading exists so there is
 * something to withhold: the list used to be bare bullets under `# Glossary`, which the strip and
 * re-attach machinery has no way to address.
 *
 * Each row now carries the DEFINITION, not just the count. That is the finding: an accepted
 * synthesis kept `term` and `docFreq` faithfully and dropped every definition, and a glossary
 * without definitions is a word-frequency table.
 *
 * `score` is rendered and named because the list is ORDERED by it (authored definitions first)
 * while only `docFreq` was visible — so `whyPeek` (6 mentions) sat below three terms with 3, and
 * the one number on screen contradicted the order. Ranking silently on a hidden field is the same
 * shape as F20's undisclosed glob semantics: correct, and unreadable.
 */
/**
 * `## Terms` — glossary list mode's reserved entry table. Declared HERE rather than in
 * `reserved-sections.ts` because that module already imports from this one, and the reverse
 * edge would be a cycle.
 */
export const GLOSSARY_TERMS_HEADING = "## Terms";

function provenanceLabel(source: GlossaryEntry["definitionSource"]): string {
  if (source === "manual") return " — authored";
  if (source === "agent") return " — agent-authored";
  return "";
}

export function renderGlossaryTermsSection(entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries.map((e) => {
    const authored = provenanceLabel(e.definitionSource);
    const head = `- **${e.term}** — ${String(e.docFreq)} mention(s), score ${e.score.toFixed(2)}${authored}`;
    // A consolidated term can legitimately have no definition. Say so, rather than render an
    // empty tail that reads as a definition which happens to be blank.
    const body =
      e.definition === null || e.definition.trim() === ""
        ? "  - _no definition recorded yet_"
        : `  - ${e.definition.trim()}`;
    return `${head}\n${body}`;
  });
  return [
    GLOSSARY_TERMS_HEADING,
    "",
    "_Ranked by relevance score, authored definitions first — not by mention count._",
    "",
    ...rows,
  ].join("\n");
}

/**
 * `list` mode's body is EMPTY: the entries moved into the reserved `## Terms` section above, so
 * the model is handed a heading and nothing else to rewrite.
 */
function renderGlossaryList(entries: readonly GlossaryEntry[]): string[] {
  return entries.length === 0 ? ["\n_No terms extracted yet._"] : [];
}

function renderGlossaryBody(brief: GlossaryBrief): string[] {
  if (brief.mode === "miss") return renderGlossaryMiss(brief);
  if (brief.mode === "term") {
    const e = brief.entries[0];
    return e === undefined ? [] : renderGlossaryEntry(brief, e);
  }
  return renderGlossaryList(brief.entries);
}

export function renderGlossary(brief: GlossaryBrief, opts?: RenderOpts): string {
  const lines: string[] = ["# Glossary", ...renderGlossaryBody(brief)];
  // List mode's entry table is reserved alongside `## Gaps` (F31a) — withheld from the model and
  // re-attached verbatim, because a rewrite that keeps the term names and drops every definition
  // leaves a word-frequency table where a glossary was.
  if (brief.mode === "list") {
    const terms = reserved(renderGlossaryTermsSection(brief.entries), opts);
    if (terms !== "") lines.push("", terms);
  }
  const gaps = reserved(renderGaps(brief.gaps), opts);
  if (gaps !== "") lines.push(gaps);
  lines.push(renderLatency(brief.latencyMs));
  return lines.join("\n");
}
