import type { DecisionEvidence } from "../../decisions/decision-types.ts";
import type { Risk } from "../../premortem/risks.ts";
import type { WatcherProposal } from "../../premortem/watcher-proposals.ts";
import {
  changelogDisclosures,
  glossaryProvenanceDisclosure,
  negotiateDecisionsDisclosure,
  negotiateIncidentsDisclosure,
  negotiateNotComputedSection,
  negotiateOwnershipDisclosures,
  negotiateSubjectVoice,
  negotiateWindowDisclosure,
  standupDisclosures,
  whyChangeSubjectDisclosure,
  windowLabel,
} from "./brief-disclosures.ts";
import type { ChangelogBrief } from "./changelog-types.ts";
import type { DecisionsBrief, DecisionsEntry } from "./decisions-types.ts";
import type {
  CatchupBrief,
  ConflictBrief,
  ConflictFinding,
  ExpertBrief,
  ExpertFinding,
  GapNote,
  GhostBrief,
  GhostFinding,
  HuddleBrief,
  ImpactBrief,
  ImpactCategory,
  ImpactFinding,
  JanitorBrief,
  PreflightBrief,
  PreflightDownstream,
} from "./findings.ts";
import type { GlossaryBrief, GlossaryEntry } from "./glossary-types.ts";
import type {
  NegotiateAuthoredPrs,
  NegotiateBrief,
  NegotiateDecisions,
  NegotiateEvidence,
  NegotiateIncidents,
  NegotiateOwnership,
  NegotiateReviewedPrs,
  NegotiateSubject,
  NegotiateTickets,
  NegotiateWriting,
} from "./negotiate-types.ts";
import type { OwnershipBrief, OwnershipTargetView } from "./ownership-types.ts";
import type { PremortemBrief } from "./premortem-types.ts";
import type { StandupBrief } from "./standup-types.ts";
import type { WhyBrief, WhyLane } from "./why-types.ts";

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

function reserved(markdown: string, opts: RenderOpts | undefined): string {
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

function renderLatency(ms: number): string {
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
function assembleBrief(
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

function renderExpertFinding(f: ExpertFinding): string {
  const head = `**${f.displayName}** (${f.confidence} — ${f.evidence.length} evidence row${
    f.evidence.length === 1 ? "" : "s"
  })`;
  if (f.evidence.length === 0) return `- ${head}`;
  const lines = f.evidence
    .slice(0, 5)
    .map((e) => `   - ${e.type.replaceAll("_", " ")}: ${e.title}`);
  return [`- ${head}`, ...lines].join("\n");
}

export function renderExpert(brief: ExpertBrief, opts?: RenderOpts): string {
  const header = `# Expert: ${brief.query.topicOrFile}`;
  const topHeading = `## Top ${brief.ranked.length}`;
  const body =
    brief.ranked.length === 0
      ? "_no people matched_"
      : brief.ranked.map(renderExpertFinding).join("\n");
  return assembleBrief(header, [topHeading, "", body], brief, opts);
}

const IMPACT_BUCKET_HEADINGS: Readonly<Record<ImpactCategory, string>> = Object.freeze({
  service: "## Services",
  pipeline: "## Pipelines",
  dashboard: "## Dashboards",
  oncall_rotation: "## Oncall",
  downstream_repo: "## Downstream Repos",
});

const IMPACT_BUCKET_ORDER: readonly ImpactCategory[] = [
  "service",
  "downstream_repo",
  "pipeline",
  "dashboard",
  "oncall_rotation",
];

function renderImpactFinding(f: ImpactFinding): string {
  return `- **${f.affectedTitle}** (\`${f.serviceId}\`, ${f.hops} hop${
    f.hops === 1 ? "" : "s"
  }) — _${f.pathSummary}_`;
}

export function renderImpact(brief: ImpactBrief, opts?: RenderOpts): string {
  const header = `# Impact: ${brief.query.fileOrPrUrl}`;
  const sections: string[] = [];
  if (brief.affected.length === 0) {
    sections.push("_no downstream impact resolved_");
  } else {
    for (const cat of IMPACT_BUCKET_ORDER) {
      const rows = brief.affected.filter((a) => a.category === cat);
      if (rows.length === 0) continue;
      const block = [IMPACT_BUCKET_HEADINGS[cat], "", ...rows.map(renderImpactFinding)].join("\n");
      sections.push(block);
    }
  }
  return assembleBrief(header, [...sections], brief, opts);
}

function renderCatchupItem(item: {
  title: string;
  itemId: string;
  relevanceScore: number;
  relevanceReasons: string[];
}): string {
  const head = `- **${item.title}** (\`${item.itemId}\`, score ${item.relevanceScore.toFixed(2)})`;
  if (item.relevanceReasons.length === 0) return head;
  const reasons = item.relevanceReasons.map((r) => `   - ${r}`).join("\n");
  return [head, reasons].join("\n");
}

export function renderCatchup(brief: CatchupBrief, opts?: RenderOpts): string {
  const header = "# Catchup";
  const sections: string[] = [];
  if (brief.sections.length === 0) {
    sections.push("_no activity in the requested window_");
  } else {
    for (const s of brief.sections) {
      const heading = `## ${s.serviceId} (${s.totalItemsInWindow} items in window)`;
      const ordered = [...s.items].sort((a, b) => b.relevanceScore - a.relevanceScore);
      const block = [heading, "", ...ordered.map(renderCatchupItem)].join("\n");
      sections.push(block);
    }
  }
  return assembleBrief(header, [...sections], brief, opts);
}

function renderGhostFinding(f: GhostFinding): string {
  const head = `**${f.expert ?? f.peerId}** (${f.rank}) — ${f.suggestedContact}`;
  if (f.context.length === 0) return `- ${head}`;
  const lines = f.context.slice(0, 5).map((c) => `   - ${c.title} (\`${c.service}\`)`);
  return [`- ${head}`, ...lines].join("\n");
}

export function renderGhost(brief: GhostBrief, opts?: RenderOpts): string {
  const header = `# Ghost: ${brief.query.file}`;
  const body =
    brief.findings.length === 0
      ? "_no teammate context found_"
      : brief.findings.map(renderGhostFinding).join("\n");
  return assembleBrief(header, [body], brief, opts);
}

function renderConflictFinding(f: ConflictFinding): string {
  return `- **${f.who ?? f.peerId}** — ${f.collisionType.replaceAll("_", " ")}: ${f.title} (\`${
    f.service
  }\`)`;
}

export function renderConflict(brief: ConflictBrief, opts?: RenderOpts): string {
  const header = `# Conflicts: ${brief.query.file}`;
  const body =
    brief.collisions.length === 0
      ? "_no work-in-progress collisions found_"
      : brief.collisions.map(renderConflictFinding).join("\n");
  return assembleBrief(header, [body], brief, opts);
}

export function renderHuddle(brief: HuddleBrief, opts?: RenderOpts): string {
  const header = "# Team Huddle";
  const sections: string[] = [];
  if (brief.contributions.length === 0) {
    sections.push("_no teammate activity in the window_");
  } else {
    for (const c of brief.contributions) {
      const heading = `## ${c.who ?? c.peerId}`;
      const lines = [
        ...c.prs.map((p) => `- PR: ${p.title}`),
        ...c.tickets.map((t) => `- Ticket: ${t.title}`),
        ...c.incidents.map((i) => `- Incident: ${i.title}`),
      ];
      sections.push([heading, "", ...(lines.length === 0 ? ["_quiet_"] : lines)].join("\n"));
    }
  }
  return assembleBrief(header, [...sections], brief, opts);
}

export function renderJanitor(brief: JanitorBrief, opts?: RenderOpts): string {
  const header = `# Janitor: ${brief.query.resourceRef}`;
  let verdict: string;
  if (brief.proposalSuppressed) {
    verdict = "_coverage incomplete — proposal withheld (pass --allow-gaps to override)_";
  } else if (brief.idle) {
    verdict =
      brief.cleanupAction === null
        ? `Idle ≥ ${brief.query.idleDays}d across ${brief.peersClear} peer(s). Consider cleanup.`
        : `Idle ≥ ${brief.query.idleDays}d across ${brief.peersClear} peer(s). Cleanup: \`nimbus run ${brief.cleanupAction} ${brief.query.resourceRef}\``;
  } else {
    const lines = brief.peersTouched.map(
      (p) => `   - ${p.who ?? p.peerId}: last seen ${p.lastSeenDaysAgo ?? "?"}d ago`,
    );
    verdict = ["Still in use:", ...lines].join("\n");
  }
  return assembleBrief(header, [verdict], brief, opts);
}

function preflightIcon(s: PreflightDownstream["status"]): string {
  if (s === "pass") return "✅ pass";
  if (s === "fail") return "❌ fail";
  if (s === "declined") return "⏸ declined";
  return "⚠ not configured";
}

export function renderPreflight(brief: PreflightBrief, opts?: RenderOpts): string {
  const header = `# Preflight: ${brief.query.ref}`;
  const body =
    brief.downstreams.length === 0
      ? "_no downstream owners reachable_"
      : brief.downstreams
          .map((d) => `- **${d.who ?? d.peerId}**: ${preflightIcon(d.status)} — ${d.summary}`)
          .join("\n");
  return assembleBrief(header, [body], brief, opts);
}

const WHY_LANE_ORDER: readonly WhyLane[] = Object.freeze([
  "authorship",
  "pull_request",
  "ticket",
  "discussion",
  "driver",
  "downstream",
]);
const WHY_LANE_HEADINGS: Readonly<Record<WhyLane, string>> = Object.freeze({
  authorship: "Authorship",
  pull_request: "Pull request",
  ticket: "Ticket",
  discussion: "Discussion",
  driver: "What drove it",
  downstream: "Downstream",
});

function renderWhySubjectLine(brief: WhyBrief): string {
  // Branch BEFORE the null check: on the prUrl arm `subject` is always null, and
  // the old line would report a resolved pull request as an unresolvable ref.
  if (brief.changeSubject !== undefined) {
    const cs = brief.changeSubject;
    if (cs === null) {
      // Deliberately does NOT say "is not in your index": `resolvePrSubject` collapses
      // several distinct misses into this one `null` (`WhyBrief` carries no reason), and one
      // of them — `not_a_pr` — resolves to an INDEXED item that simply isn't a pull request
      // (e.g. the URL trims to an indexed issue or repo). Asserting absence would be false in
      // that case, so the sentence stays neutral about which miss occurred.
      return `_\`${brief.query.ref}\` did not resolve to a pull request in your index._`;
    }
    const num = cs.number === null ? "" : `#${String(cs.number)}`;
    return [`\`${cs.repo}${num}\` — ${cs.title}`, "", whyChangeSubjectDisclosure().line].join("\n");
  }
  if (brief.subject === null) {
    return `_Could not resolve \`${brief.query.ref}\` to an indexed location._`;
  }
  const lineSuffix = brief.subject.lineNo === null ? "" : `:${String(brief.subject.lineNo)}`;
  return `\`${brief.subject.filePath}${lineSuffix}\` in \`${brief.subject.repoRoot}\``;
}

export function renderWhy(brief: WhyBrief, opts?: RenderOpts): string {
  const lines: string[] = ["# Why"];
  lines.push(renderWhySubjectLine(brief));
  for (const lane of WHY_LANE_ORDER) {
    const rows = brief.findings.filter((f) => f.lane === lane);
    if (rows.length === 0) continue;
    lines.push(`\n## ${WHY_LANE_HEADINGS[lane]}`);
    for (const f of rows) {
      const when =
        f.occurredAt === null ? "" : ` — ${new Date(f.occurredAt).toISOString().slice(0, 10)}`;
      const head = f.url === null ? `**${f.title}**` : `**[${f.title}](${f.url})**`;
      lines.push(`- ${head}${when}\n  ${f.detail}`);
    }
  }
  const gaps = reserved(renderGaps(brief.gaps), opts);
  if (gaps !== "") lines.push(gaps);
  lines.push(renderLatency(brief.latencyMs));
  return lines.join("\n");
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

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

export function renderGlossaryTermsSection(entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries.map((e) => {
    const authored = e.definitionSource === "manual" ? " — authored" : "";
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

function renderOwnershipCounts(t: OwnershipTargetView): string {
  if (t.ownerCount === null || t.ownersAboveFloor === null) {
    return "      (owner breakdown not recorded for this path — run `nimbus owners --refresh`)";
  }
  const floor = `${String(t.ownersAboveFloor)} of ${String(t.ownerCount)} contributor(s) clear the share floor`;
  return t.truncated === true
    ? `      (${floor}; showing top ${String(t.owners.length)})`
    : `      (${floor})`;
}

function renderOwnershipTarget(heading: string, t: OwnershipTargetView | null): string[] {
  if (t === null) return [];
  if (t.owners.length === 0) {
    // Counts recorded but nobody cleared the share floor is a different fact than
    // nothing recorded at all — a reader must not confuse the two. Gate on
    // `ownersAboveFloor` presence, matching `parseCounts` in ownership-store.ts: a
    // legacy row (written before the ownerCount/ownersAboveFloor split) has a
    // non-null `ownerCount` but a null `ownersAboveFloor`, and must report as
    // unrecorded, not assert a floor result the row never recorded.
    if (t.ownersAboveFloor === null) {
      return [
        `### ${heading} — ${t.displayPath}`,
        "",
        "_Owner breakdown not recorded for this path — run `nimbus owners --refresh`._",
        "",
      ];
    }
    if (t.ownerCount !== null && t.ownerCount > 0) {
      return [
        `### ${heading} — ${t.displayPath}`,
        "",
        "_No owners cleared the share floor._",
        renderOwnershipCounts(t),
        "",
      ];
    }
    return [`### ${heading} — ${t.displayPath}`, "", "_No owners recorded._", ""];
  }
  const rows = t.owners.map((o, i) => {
    const pct = `${(o.share * 100).toFixed(1)}%`;
    const mark = o.resolved ? "" : "  (unresolved git identity)";
    return `  ${String(i + 1)}. ${o.label.padEnd(28)} ${pct}${mark}`;
  });
  return [`### ${heading} — ${t.displayPath}`, "", ...rows, renderOwnershipCounts(t), ""];
}

export function renderOwnership(brief: OwnershipBrief, opts?: RenderOpts): string {
  const subject = brief.query.path ?? brief.query.service ?? "coverage";
  const header = `## Ownership · ${subject}`;
  const sections = [
    ...renderOwnershipTarget("Owners", brief.target),
    ...renderOwnershipTarget("Directory", brief.parentDirectory),
  ];
  const svc = brief.service === null ? [] : [`### Rolls up to service: ${brief.service.id}`, ""];
  const cov = [
    "### Coverage",
    "",
    `  roots ${String(brief.coverage.rootsCovered)}/${String(brief.coverage.rootsTotal)} · ` +
      `files ${String(brief.coverage.filesCovered)} · ` +
      `excluded ${String(brief.coverage.filesExcluded)} · ` +
      `services ${String(brief.coverage.servicesBound)}`,
  ];
  const body = [...sections, ...svc, ...cov].join("\n");
  return assembleBrief(header, [body], brief, opts);
}

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

function renderPremortemRisk(r: Risk): string {
  const kindLabel = r.kind.replaceAll("_", " ");
  const suffix = r.expectationOnly ? " (expectation)" : "";
  return `- **${kindLabel}**${suffix}: ${r.summary}`;
}

/**
 * `w.watcherId` is the real, stable id `insertWatcherIfAbsent` wrote (or
 * would have written) — the ONLY handle a reader can act on, so it must be
 * printed, not just the service name. A `suppressed` proposal points at
 * `--repropose` (the sole path back from a deliberate deletion,
 * `clearProposalTombstones`); a live one points at `nimbus watch resume`
 * (the watcher is created PAUSED, by design).
 */
function renderPremortemWatcher(w: WatcherProposal, epicRef: string): string {
  if (w.state === "suppressed") {
    return (
      `- ${w.service} — suppressed (id \`${w.watcherId}\`); this watcher was deliberately ` +
      `deleted on a previous run. Re-create it with \`nimbus pre-mortem ${epicRef} --repropose\`.`
    );
  }
  const stateLabel = w.state === "created" ? "created" : "already present";
  return (
    `- ${w.service} — ${stateLabel} (id \`${w.watcherId}\`, paused). ` +
    `Enable it with \`nimbus watch resume ${w.watcherId}\`.`
  );
}

export function renderPremortem(brief: PremortemBrief, opts?: RenderOpts): string {
  const header = `# Pre-mortem: ${brief.query.epicRef}`;
  const sections: string[] = [];

  if (brief.epic !== null) {
    sections.push(`_${brief.epic.key} — ${brief.epic.title}_`);
  }

  if (brief.services.length > 0) {
    // The bullet list is built first rather than nested inside the section
    // template: a template literal inside a template literal is legal but reads
    // as one expression when it is really two (Sonar S4624).
    const serviceBullets = brief.services.map((s) => `- ${s}`).join("\n");
    sections.push(`\n## Services\n\n${serviceBullets}`);
  }

  if (brief.cohort.members.length > 0) {
    const rows = brief.cohort.members.map((m) => `- ${m.key} — ${m.title}`);
    sections.push(
      `\n## Comparable epics (${String(brief.cohort.members.length)})\n\n${rows.join("\n")}`,
    );
  }

  if (brief.risks.length > 0) {
    sections.push(`\n## Risks\n\n${brief.risks.map(renderPremortemRisk).join("\n")}`);
  }

  if (brief.themes.length > 0) {
    const rows = brief.themes.map(
      (t) => `- ${t.label} (${t.service}, confidence ${t.confidence.toFixed(2)})`,
    );
    sections.push(`\n## Recurring themes\n\n${rows.join("\n")}`);
  }

  if (brief.watchers.length > 0) {
    const rows = brief.watchers.map((w) => renderPremortemWatcher(w, brief.query.epicRef));
    sections.push(`\n## Watcher proposals\n\n${rows.join("\n")}`);
  }

  return assembleBrief(header, [...sections], brief, opts);
}

/**
 * `subject.isOther` is true only when `--person <id>` named someone whose id differs
 * from the separately-resolved local user (`negotiate.ts` `resolveSubject` always
 * resolves both and compares) — `--person <your own id>` reads as a normal self brief,
 * not "someone other than you". The explicit-subject case always has a non-null
 * `personId`, so the fallback below is defensive, not reachable in practice. The
 * local-user case deliberately does not name the person: an unresolved local subject
 * already carries a `missing_user_identity` gap note.
 */
function renderNegotiateSubjectLine(subject: NegotiateSubject): string {
  if (subject.isOther) {
    const label = subject.displayName ?? subject.personId ?? "unknown person";
    return `**Subject:** ${label} — brief requested for someone other than you`;
  }
  return "**Subject:** you";
}

/**
 * Escapes a citation title for the `[...]` position of a Markdown link.
 *
 * ONE pass over a character class that INCLUDES the backslash — deliberately not a chain of
 * `.replace(/\[/g, "\\[").replace(/\]/g, "\\]")`. That chain is order-dependent and wrong:
 * a title containing `\[` has its bracket escaped to `\\[`, where the doubled backslash
 * renders as a literal backslash and the bracket is live again, breaking out of the link
 * text. Item titles are EXTERNAL input (a PR title, an issue title, a decision statement),
 * so "no one would write that" is not an argument. CodeQL `js/incomplete-sanitization`
 * caught exactly this. Escaping the escape character first — or in the same pass — is the
 * only correct shape.
 */
function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * The `(...)` target of a citation link, or `null` when the url cannot be rendered safely.
 *
 * Two separate guards, both fail-safe toward plain text:
 *
 * 1. **Scheme allow-list.** A connector-supplied `canonical_url` is external input, and this
 *    brief is rendered in the Tauri renderer — a `javascript:` or `data:` target would be a
 *    live script-execution vector with only the CSP (I8) behind it. Written as what MAY pass,
 *    never as a list of what may not.
 * 2. **Delimiter encoding.** `(`, `)` and whitespace terminate the target in Markdown, so a
 *    url containing them would truncate the link and spill the remainder into the document
 *    as text — worst case pointing the citation somewhere other than the evidence.
 *
 * The parens are encoded from an explicit map, NOT via `encodeURIComponent`: that function
 * leaves `(`, `)`, `!`, `'` and `*` untouched — they are "unreserved marks" in its spec — so
 * `encodeURIComponent(")")` returns `)` and the guard would be silently inert for the two
 * characters it exists to neutralise. Whitespace is the one case `encodeURIComponent` does
 * handle, and the `URL` parser has usually already encoded it.
 */
const HREF_DELIMITER_ESCAPES: Readonly<Record<string, string>> = { "(": "%28", ")": "%29" };

function safeEvidenceHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href.replace(/[()\s]/g, (c) => HREF_DELIMITER_ESCAPES[c] ?? encodeURIComponent(c));
}

/**
 * The citation block under a lane's headline count.
 *
 * Returns `[]` — not a "no evidence" line — when there is nothing to cite: a lane that
 * counted zero has already said so, and an empty population needs no citation. The
 * truncation line is emitted from `total - refs.length` so a capped list can never read as
 * exhaustive, the same self-disclosure rule `statsCoverage` follows.
 *
 * A ref with no usable url renders as plain text, never as a link to nowhere.
 */
function renderNegotiateEvidence(evidence: NegotiateEvidence): string[] {
  if (evidence.refs.length === 0) return [];
  const lines = evidence.refs.map((r) => {
    const title = escapeMarkdownLinkText(r.title);
    const href = r.url === null ? null : safeEvidenceHref(r.url);
    return href === null ? `  - ${title}` : `  - [${title}](${href})`;
  });
  const remaining = evidence.total - evidence.refs.length;
  if (remaining > 0) lines.push(`  - …and ${String(remaining)} more not listed`);
  return lines;
}

/**
 * A `null` lane means "could not be computed" (failed, or never attempted for lack of a
 * resolved subject) and must never render as `0` — that distinction is the entire reason
 * `authoredPrs` is nullable rather than defaulting to an all-zero object.
 */
function renderNegotiateAuthoredPrs(a: NegotiateAuthoredPrs | null): string {
  if (a === null) {
    return negotiateNotComputedSection("PRs authored");
  }
  const lines = ["## PRs authored", "", `- ${String(a.count)} PR(s), ${String(a.merged)} merged`];
  if (a.stats === null) {
    // Only when there was something to enrich. With zero authored PRs in the window,
    // "no enriched PR in this window" reads as a coverage failure over a real population
    // rather than what it is — an empty population, already stated by the line above.
    if (a.statsCoverage.total > 0) {
      lines.push("- stats: not available (no enriched PR in this window)");
    }
  } else {
    const coverageSuffix =
      a.statsCoverage.covered < a.statsCoverage.total
        ? ` (stats coverage ${String(a.statsCoverage.covered)}/${String(a.statsCoverage.total)})`
        : "";
    lines.push(
      `- stats: +${String(a.stats.additions)} / -${String(a.stats.deletions)} across ${String(
        a.stats.changedFiles,
      )} file(s)${coverageSuffix}`,
    );
  }
  lines.push(...renderNegotiateEvidence(a.evidence));
  return lines.join("\n");
}

/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateReviewedPrs(r: NegotiateReviewedPrs | null): string {
  if (r === null) {
    return negotiateNotComputedSection("PRs reviewed");
  }
  const lines = [
    "## PRs reviewed",
    "",
    `- ${String(r.count)} review(s): ${String(r.approved)} approved, ${String(
      r.changesRequested,
    )} changes requested, ${String(r.otherOrUnknown)} other/unknown`,
  ];
  lines.push(...renderNegotiateEvidence(r.evidence));
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. `unattributable`
 * follows the same disclosure shape as `NegotiateDecisions.unattributable` (see
 * `renderNegotiateDecisions`'s docstring), but with TWO differences: a zero `unattributable` is
 * omitted entirely rather than stated as zero ("0 incidents attributed to nobody" reads as a
 * warning about a problem that does not exist — the counted lines above it already say what did
 * happen, so a zero here has nothing to add), and the caveat names no cause at all. This count is
 * dominated by cases the code cannot distinguish from each other — chiefly incidents that
 * auto-resolved with no human actor, which is not a data-quality problem — so, exactly like the
 * decisions caveat, it states the fact and disclaims a specific reading without asserting why.
 */
function renderNegotiateIncidents(i: NegotiateIncidents | null): string {
  if (i === null) {
    return negotiateNotComputedSection("Incidents");
  }
  const lines = [
    "## Incidents",
    "",
    `- ${String(i.resolved)} resolved, ${String(i.assigned)} assigned`,
  ];
  // Its own line, never summed into the incident counts (spec § 5.7). Suppressed
  // at zero: with no Sentry connector this lane is structurally empty, and a
  // printed "0 assigned" would read as a measurement of the person rather than
  // of the index. The gap note carries that case instead.
  if (i.errorIssuesAssigned > 0) {
    lines.push(`- ${String(i.errorIssuesAssigned)} Sentry error issue(s) assigned`);
  }
  const unattributable = negotiateIncidentsDisclosure(i);
  if (unattributable !== undefined) lines.push(unattributable.line);
  lines.push(...renderNegotiateEvidence(i.evidence));
  return lines.join("\n");
}

/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateTickets(t: NegotiateTickets | null): string {
  if (t === null) {
    return negotiateNotComputedSection("Tickets");
  }
  const lines = [
    "## Tickets",
    "",
    `- ${String(t.opened)} opened, ${String(t.closedByAuthoredPr)} closed by an authored PR`,
  ];
  // Cites the OPENED issues only — see `NegotiateTickets.evidence` for why the
  // closed-by-authored-PR hop is deliberately not cited here.
  lines.push(...renderNegotiateEvidence(t.evidence));
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. The
 * undercount guard (Task 4, spec § 5.A0) surfaces here as an unconditional line: it is a
 * fact about the index (never an attribution to the subject), so it renders whenever it is
 * non-zero, not just when the lane otherwise has something to say.
 */
function renderNegotiateOwnership(o: NegotiateOwnership | null): string {
  if (o === null) {
    return negotiateNotComputedSection("Ownership");
  }
  const lines = ["## Ownership", ""];
  if (o.services.length === 0 && o.directories.length === 0) {
    lines.push("- no recorded ownership");
  } else {
    if (o.services.length > 0) lines.push(`- services: ${o.services.join(", ")}`);
    if (o.directories.length > 0) lines.push(`- directories: ${o.directories.join(", ")}`);
  }
  lines.push(
    o.lastPassAt === null
      ? "- ownership pass: never run (`nimbus owners --refresh`)"
      : `- ownership pass last ran ${new Date(o.lastPassAt).toISOString()}`,
  );
  const disclosures = negotiateOwnershipDisclosures(o);
  if (disclosures.truncation !== undefined) lines.push(disclosures.truncation.line);
  if (o.unmappedIdentitiesInIndex > 0) {
    lines.push(
      `- ${String(o.unmappedIdentitiesInIndex)} git identities in this index are not mapped ` +
        "to a person; ownership attributed to them is not counted here.",
    );
  }
  // Unconditional, exactly as `nimbus owners` states it in every brief (`agents/ownership.ts`):
  // this lane reads the SAME `owns` edges, which are derived from git blame. Under a heading
  // like "## Ownership — services: checkout", inside a document about someone's contribution,
  // an unlabelled ownership claim reads as formal accountability. The sentence itself lives in
  // `brief-disclosures.ts`, which is also what the synthesis contract guard requires to survive.
  lines.push(disclosures.accountability.line);
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. Same
 * disambiguation problem as `renderNegotiateOwnership`'s `unmappedIdentitiesInIndex`
 * (Task 4): `unattributable` is a fact about the INDEX — decisions mined from a source
 * (Obsidian, Teams) that records no author AT ALL, which is precisely and only what
 * `laneDecisions` queries (`i.author_id IS NULL`). It is NOT "decisions authored by someone
 * else": those are simply absent from both counts. Do not widen the query to match a looser
 * reading of this comment — that would inflate `unattributable` and make the rendered line
 * below false.
 *
 * Printed next to `authored` with no disambiguating text, a reader (or their manager) could
 * misread "N authored, M unattributable" as "N + M decisions, M just not linked to me" — the
 * undercount failure inverted into an overstatement, which is worse (spec § 8.2, Task 5
 * fix-round-1). The line must therefore read as "N decisions attributed to <subject>; M
 * decisions exist in the index with no attributable author, not counted above and not
 * necessarily <subject>'s" — matching `renderNegotiateOwnership`'s "attributed to them is not
 * counted here" phrasing. The subject is threaded in rather than hardcoded to "you" for the
 * same reason `renderNegotiateSubjectLine` takes it.
 */
function renderNegotiateDecisions(d: NegotiateDecisions | null, subject: NegotiateSubject): string {
  if (d === null) {
    return negotiateNotComputedSection("Decisions");
  }
  const voice = negotiateSubjectVoice(subject);
  const lines = [
    "## Decisions",
    "",
    `- ${String(d.authored)} decision(s) attributed to ${voice.addressed}`,
    negotiateDecisionsDisclosure(d, subject).line,
  ];
  lines.push(...renderNegotiateEvidence(d.evidence));
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. `docs` and
 * `notes` each partly reflect the `[negotiate] personal_sources` gate (spec § 3.3) — see
 * `NegotiateWriting`'s docstring and `negotiate.ts`'s `PERSONAL_CAPABLE_SERVICES` for which
 * services that covers; this line never explains *why* a count reads low/zero — that
 * disclosure lives in `renderNegotiateSources`, unconditionally, so it is stated once
 * rather than repeated (and not restated here, so the two cannot drift apart).
 */
function renderNegotiateWriting(w: NegotiateWriting | null): string {
  if (w === null) {
    return negotiateNotComputedSection("Writing");
  }
  const lines = [
    "## Writing",
    "",
    `- ${String(w.docs)} doc(s), ${String(w.notes)} note(s), ${String(w.messages)} message(s) authored`,
  ];
  lines.push(...renderNegotiateEvidence(w.evidence));
  return lines.join("\n");
}

/**
 * Sources the brief drew on (spec § 5.F). Rendered unconditionally, like
 * `unavailableEvidence`: when no personal source is configured, the section states so by
 * name — `personalDocsConfigKey` — so an empty personal-sources result reads as "not
 * enabled", never as "nothing found".
 */
export function renderNegotiateSources(sources: NegotiateBrief["sources"]): string {
  const ignored = renderIgnoredPersonalSources(sources.personalDocsUnrecognised);
  // Three states, not two. Telling a reader to "set `[negotiate] personal_sources`" when they
  // have already set it — and every entry was unrecognised — is the advice that wastes the
  // most time, so that case gets its own line saying what actually went wrong.
  let line: string;
  if (sources.personalDocsConfigured) {
    line = `- personal document sources: ${sources.personalDocsRecognised.join(
      ", ",
    )} — configured and included in the writing lane above${ignored}`;
  } else if (sources.personalDocsUnrecognised.length > 0) {
    line = `- personal document sources are not enabled: no entry in \`${sources.personalDocsConfigKey}\` matched a personal-capable service${ignored}`;
  } else {
    line = `- personal document sources are not enabled (set \`${sources.personalDocsConfigKey}\` in nimbus.toml to include them)`;
  }
  return ["## Sources", "", line].join("\n");
}

/**
 * The unconditional list of evidence classes this agent structurally cannot measure.
 * Extracted from `renderNegotiate`'s inline array so `reserved-sections.ts` can build the
 * identical block from the identical input — the two halves of a split brief must be the
 * same function on the same data, never two renderings that could drift.
 *
 * Takes the field rather than the whole brief, matching `renderNegotiateSources(brief.sources)`
 * beside it: a whole-brief parameter would force every caller and test to construct (or cast)
 * a full `NegotiateBrief` to exercise one list.
 */
export function renderNegotiateEvidenceSection(unavailableEvidence: readonly string[]): string {
  return [
    "## Evidence not available from the index",
    "",
    ...unavailableEvidence.map((e) => `- ${e}`),
  ].join("\n");
}

/**
 * The disclosure half of the `personalDocsConfigured` fix. An entry that matches no
 * personal-capable service widens nothing, so dropping it silently leaves a mis-typed or
 * mis-named opt-in indistinguishable from a source that was genuinely empty — and, before
 * `personalDocsConfigured` became an intersection, made an undercount render as complete
 * coverage. The entries are echoed back quoted so the reader can see the exact string their
 * `nimbus.toml` carries.
 */
function renderIgnoredPersonalSources(unrecognised: readonly string[]): string {
  if (unrecognised.length === 0) return "";
  const noun = unrecognised.length === 1 ? "entry" : "entries";
  const quoted = unrecognised.map((s) => `"${s}"`).join(", ");
  return ` (${String(unrecognised.length)} unrecognised ${noun} ignored: ${quoted})`;
}

/**
 * Task 1's version rendered only the subject, the window and generation time, the gap
 * notes, and the unconditional `unavailableEvidence` list. Task 2 added the authored/
 * reviewed PR lane sections; Task 3 adds the tickets lane; Task 4 adds ownership; Task 5
 * adds decisions; Task 6 adds writing + sources; Task 11 adds incidents, between tickets
 * and ownership — a lane whose field is `null` renders as "could not be computed", never
 * as `0`; each later lane task extends this further the same way.
 */
export function renderNegotiate(brief: NegotiateBrief, opts?: RenderOpts): string {
  const header = "# Negotiation brief";
  const subjectLine = renderNegotiateSubjectLine(brief.subject);
  // The window clause is a disclosure, not decoration. `item` has no creation timestamp, so
  // every item-backed lane filters on `modified_at` — GitHub's `updated_at`, i.e. LAST TOUCH.
  // Under a bare "_window: last 90d_" header, "40 PR(s)" is read as "40 authored this quarter"
  // when the query actually means "40 you authored at any time that were touched in this
  // window" — a systematic OVERSTATEMENT of the headline numbers, the failure direction this
  // agent exists to avoid. Re-querying on creation date is unavailable, so saying so is the fix.
  // It sits in the PREAMBLE because it qualifies every count below it; the synthesis contract
  // guard reaches it there through `preambleBody`, not through any section.
  const windowLine = negotiateWindowDisclosure(brief.query.sinceMs, brief.generatedAt).line;
  const authoredPrs = renderNegotiateAuthoredPrs(brief.authoredPrs);
  const reviewedPrs = renderNegotiateReviewedPrs(brief.reviewedPrs);
  const tickets = renderNegotiateTickets(brief.tickets);
  const incidents = renderNegotiateIncidents(brief.incidents);
  const ownership = renderNegotiateOwnership(brief.ownership);
  const decisions = renderNegotiateDecisions(brief.decisions, brief.subject);
  const writing = renderNegotiateWriting(brief.writing);
  const sources = reserved(renderNegotiateSources(brief.sources), opts);
  const evidence = reserved(renderNegotiateEvidenceSection(brief.unavailableEvidence), opts);
  const gaps = reserved(renderGaps(brief.gaps), opts);
  const footer = renderLatency(brief.latencyMs);
  return [
    header,
    "",
    subjectLine,
    windowLine,
    "",
    authoredPrs,
    "",
    reviewedPrs,
    "",
    tickets,
    "",
    incidents,
    "",
    ownership,
    "",
    decisions,
    "",
    writing,
    "",
    sources,
    "",
    evidence,
    gaps,
    footer,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Every character that can END A LINE (or reorder one) inside a Markdown document, dropped.
 *
 * `escapeMarkdownLinkText` hardens brackets and backslashes and nothing else, which is correct
 * for its own job and insufficient on its own here: a title is arbitrary connector-supplied text
 * (`index/item-store.ts` stores `item.title` verbatim — no connector or writer strips control
 * characters from it), so a PR or incident subject containing `\n## Gaps` ends the entry's list
 * item and renders the remainder as a LEVEL-2 HEADING of its own. That plants a fabricated
 * section — potentially a reserved one — in the deterministic render, which is the artifact I31
 * exists to keep honest. `changelogScopeLabel` below already makes this exact argument for
 * `--service`, which is merely OWNER-supplied; the entry title is the stronger case, not the
 * weaker one.
 *
 * Dropped rather than substituted, for `changelogScopeLabel`'s reason: a replacement character
 * is a second thing the reader has to interpret, and nothing legitimate arrives carrying one.
 * `\p{Cc}` covers CR/LF and the C0/C1 controls, `\p{Cf}` the bidi overrides and zero-width
 * joiners, `\p{Zl}`/`\p{Zp}` U+2028 and U+2029.
 */
function stripLineStructureChars(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

/**
 * The fields an entry renderer reads, and nothing else.
 *
 * Structural rather than `ChangelogRow`, so `renderStandup` shares these two functions instead
 * of copying them. That sharing is the point: the hardening below is security-relevant and was
 * WRONG once already — the changelog PR shipped `--format slack|plain` with links unconverted
 * because the escaping here and the CLI's link regex disagreed about an escaped bracket, a seam
 * no per-file review saw. A second brief with its own copy is a second place for that to happen,
 * and the two row types differ only in a field neither function reads (`timeSource` /
 * `timeBasis`).
 */
type RenderableEntry = {
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number;
};

/**
 * One entry. Linked when the indexed item carried a permalink that can be rendered safely,
 * plain otherwise — never a link to nowhere.
 *
 * Both halves go through `negotiate`'s hardened helpers rather than being interpolated raw,
 * because BOTH halves are connector-supplied: the title is a pull-request or incident subject
 * written by whoever opened it, and the url is a connector's `canonical_url`. A title
 * containing `](` closes the link early and takes the rest of the line with it, and a
 * `javascript:` target is live in the Tauri renderer with only the CSP (I8) behind it.
 * `renderWhy` and `renderDecisionsEvidenceItem` interpolate raw; that is the older shape, not
 * the one to copy.
 *
 * `stamp` is injected because the right precision is a property of the WINDOW, not of the
 * renderer: a changelog over 7d wants the date, and a standup over 24h wants the time — every
 * entry in it would otherwise read `2026-09-12`, collapsing the ordering information the reader
 * came for into one indistinguishable value.
 */
function renderBriefEntry(r: RenderableEntry, stamp: (ms: number) => string): string {
  const title = escapeMarkdownLinkText(stripLineStructureChars(r.title));
  const href = r.url === null ? null : safeEvidenceHref(r.url);
  const head = href === null ? title : `[${title}](${href})`;
  return `- ${head} — ${stamp(r.atMs)}`;
}

/**
 * A category section, rendered whether or not it has entries.
 *
 * The empty case prints its heading and `_None in this window._` rather than being omitted:
 * a missing heading and an empty one say different things — "this changelog does not cover
 * deployments" versus "no deployment happened in this window" — and the reader cannot tell
 * them apart from an absence. The whole point of these briefs is that silence is never evidence.
 */
function renderEntrySection(
  heading: string,
  rows: readonly RenderableEntry[],
  stamp: (ms: number) => string,
): string {
  const body =
    rows.length === 0
      ? "_None in this window._"
      : rows.map((r) => renderBriefEntry(r, stamp)).join("\n");
  return ["", `## ${heading}`, "", body].join("\n");
}

/**
 * The `--service` the owner asked for, as it appears inside an inline-code span in the PREAMBLE.
 *
 * Interpolating it raw was the odd one out on this brief: the entry title and href beside it are
 * both hardened. The value is owner-supplied and bounded (`ipc/agents-rpc.ts` trims it and caps
 * it at `MAX_SERVICE_LEN`), and `agents.changelog` is not on the Tauri allowlist, so the only
 * reachable case is an owner injecting into their own brief. But that validator rejects no
 * CONTROL character: a newline would end the preamble line and let the remainder render as a
 * `## ` heading of its own — inside the exact region the I31 disclosures live in, where a
 * fabricated section is the failure this brief's whole disclosure design exists to prevent.
 * Backticks go for the reason one level down: either of them closes the code span early.
 *
 * Dropped rather than substituted: a replacement character would be a second thing the reader
 * has to interpret, and nothing legitimate reaches here carrying one.
 *
 * Shares {@link stripLineStructureChars} with the entry title rather than repeating its class:
 * the backtick is the ONLY difference, and it matters here alone because this value sits inside
 * an inline-code span that a backtick would close early.
 */
function changelogScopeLabel(service: string): string {
  return stripLineStructureChars(service).replaceAll("`", "");
}

export function renderChangelog(brief: ChangelogBrief, opts?: RenderOpts): string {
  const header = "# Changelog";
  const scope =
    brief.query.service === null
      ? "_scope: all services_"
      : `_scope: service \`${changelogScopeLabel(brief.query.service)}\`_`;
  // The disclosures sit in the PREAMBLE — above the first `##` — because each one qualifies
  // every category section below it. `preambleBody` (`markdown-sections.ts`) stops at the first
  // LEVEL-2 heading, which is why this brief's title is `#` and not `##`: under a level-2 title
  // the preamble would be empty and `contractViolations` could never reach these sentences.
  const preamble = [
    "",
    // `windowLabel`, not `Math.round(span / 86_400_000)`: `--since 6h` is a documented example
    // in `cli-reference.md`, and a day-only label renders it as "last 0d" — a window the lanes
    // did not query, stated one line above the unconditional "Counts and entries below cover
    // only this window" disclosure. The dates keep the absolute bounds visible either way.
    `_window: last ${windowLabel(brief.query.nowMs - brief.query.sinceMs)} (${isoDay(brief.query.sinceMs)} → ${isoDay(brief.query.nowMs)})_`,
    scope,
    ...changelogDisclosures(brief).map((d) => d.line),
  ].join("\n");
  const sections = [
    renderEntrySection("Merged Pull Requests", brief.mergedPrs, isoDay),
    renderEntrySection("Deployments", brief.deployments, isoDay),
    renderEntrySection("Incidents Opened", brief.incidentsOpened, isoDay),
    renderEntrySection("Incidents Resolved", brief.incidentsResolved, isoDay),
  ].join("\n");
  return assembleBrief(header, [preamble, sections], brief, opts);
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
function isoMinuteUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/**
 * Who the standup is about, as it appears inside an inline-code span in the PREAMBLE.
 *
 * Hardened for `changelogScopeLabel`'s reason and then some: unlike `--service`, which is
 * owner-supplied and length-capped by the RPC validator, a display name is CONNECTOR-supplied —
 * it is whatever a Slack profile or Jira account claimed — so a newline in it would end the
 * preamble line and let the remainder render as a `## ` heading of its own, inside the exact
 * region the I31 disclosures live in. The person ID falls back the same way, since
 * `[user] mePersonId` reaches here verbatim (`self-person.ts` short-circuits on it without
 * validation) and the RPC validator caps its length but rejects no control character.
 */
function standupWhoLabel(identity: StandupBrief["identity"]): string {
  const raw = identity.displayName ?? identity.personId;
  return stripLineStructureChars(raw).replaceAll("`", "");
}

/**
 * How the identity was decided, spelled out for the reader rather than left as a bare id.
 *
 * `source` changes how much an empty section is worth trusting, so it belongs on the page and
 * not only in `findings`: `git` matched a configured email against an indexed person, `override`
 * was taken from `nimbus.toml` and never checked against the index at all, and `os` is a
 * heuristic that can land on a colleague whose GitHub login equals this machine's username.
 * `unresolved` is unreachable — `emitStandupBrief` refuses before building a brief — but is
 * rendered rather than omitted, because a `TIME_BASIS`-style total map is what keeps a future
 * fourth source from silently rendering as nothing.
 */
const STANDUP_SOURCE_LABEL: Readonly<Record<StandupBrief["identity"]["source"], string>> =
  Object.freeze({
    override: "pinned by `[user] mePersonId`",
    git: "matched from `git config user.email`",
    os: "guessed from your OS username",
    unresolved: "unresolved",
  });

export function renderStandup(brief: StandupBrief, opts?: RenderOpts): string {
  const header = "# Standup";
  // The disclosures sit in the PREAMBLE — above the first `##` — because each qualifies every
  // section below it. `preambleBody` (`markdown-sections.ts`) stops at the first LEVEL-2
  // heading, which is why this brief's title is `#` and not `##`: under a level-2 title the
  // preamble would be empty and `contractViolations` could never reach these sentences.
  const preamble = [
    "",
    // `windowLabel`, never `Math.round(span / 86_400_000)`: the DEFAULT window here is `24h` and
    // `--since 6h` is an ordinary use, both of which a day-only label renders as "last 0d" or
    // "last 1d" — a window the lanes did not query, printed one line above the unconditional
    // "Counts and entries below cover only this window" disclosure. `renderChangelog` shipped
    // exactly that defect; on this brief it would be the common case rather than the edge one.
    `_window: last ${windowLabel(brief.query.nowMs - brief.query.sinceMs)} (${isoMinuteUtc(brief.query.sinceMs)} → ${isoMinuteUtc(brief.query.nowMs)})_`,
    `_for: \`${standupWhoLabel(brief.identity)}\` (${STANDUP_SOURCE_LABEL[brief.identity.source]})_`,
    ...standupDisclosures(brief).map((d) => d.line),
  ].join("\n");
  const sections = [
    renderEntrySection("Pull requests active", brief.prsActive, isoMinuteUtc),
    renderEntrySection("Pull requests merged", brief.prsMerged, isoMinuteUtc),
    renderEntrySection("Reviews given", brief.reviews, isoMinuteUtc),
    renderEntrySection("Tickets opened", brief.ticketsOpened, isoMinuteUtc),
    renderEntrySection("Incidents responded to", brief.incidents, isoMinuteUtc),
    renderStandupSlackSection(brief),
  ].join("\n");
  return assembleBrief(header, [preamble, sections], brief, opts);
}

/**
 * Slack activity, headed by its THREAD count rather than only its message count.
 *
 * "Slack threads participated in" is the unit the roadmap names and the one a standup reader
 * wants: eleven replies in one thread is one conversation, not eleven items of work. Both
 * numbers are printed because neither alone is the answer — the thread count is the shape of the
 * day and the message count is the volume — and printing the thread count while listing messages
 * without saying which is which would leave the reader unable to reconcile a "3 threads" heading
 * with eleven bullets beneath it.
 *
 * Reuses {@link renderEntrySection}'s empty-case wording via that function rather than
 * hand-rolling this one: an empty Slack section must read `_None in this window._` exactly like
 * every other lane, since the alternative is a section that looks omitted rather than empty.
 */
function renderStandupSlackSection(brief: StandupBrief): string {
  const section = renderEntrySection("Slack activity", brief.messages, isoMinuteUtc);
  if (brief.counts.messages === 0) return section;
  const n = brief.counts.messages;
  const t = brief.threadCount;
  const summary =
    `_${String(n)} message${n === 1 ? "" : "s"} across ` +
    `${String(t)} thread${t === 1 ? "" : "s"}._`;
  // Inserted after the heading's blank line rather than appended, so the summary is read before
  // the bullets it counts. `renderEntrySection` returns `["", "## …", "", body]` joined, so
  // splicing at index 3 puts this exactly where the body starts.
  const parts = section.split("\n");
  return [...parts.slice(0, 3), summary, "", ...parts.slice(3)].join("\n");
}
