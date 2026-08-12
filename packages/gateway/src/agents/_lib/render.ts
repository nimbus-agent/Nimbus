import type { DecisionEvidence } from "../../decisions/decision-types.ts";
import type { Risk } from "../../premortem/risks.ts";
import type { WatcherProposal } from "../../premortem/watcher-proposals.ts";
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
  NegotiateOwnership,
  NegotiateReviewedPrs,
  NegotiateSubject,
  NegotiateTickets,
} from "./negotiate-types.ts";
import type { OwnershipBrief, OwnershipTargetView } from "./ownership-types.ts";
import type { PremortemBrief } from "./premortem-types.ts";
import type { WhyBrief, WhyLane } from "./why-types.ts";

function renderGaps(gaps: GapNote[]): string {
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

export function renderExpert(brief: ExpertBrief): string {
  const header = `# Expert: ${brief.query.topicOrFile}`;
  const topHeading = `## Top ${brief.ranked.length}`;
  const body =
    brief.ranked.length === 0
      ? "_no people matched_"
      : brief.ranked.map(renderExpertFinding).join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", topHeading, "", body, gaps, footer].filter((s) => s !== "").join("\n");
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

export function renderImpact(brief: ImpactBrief): string {
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
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", ...sections, gaps, footer].filter((s) => s !== "").join("\n");
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

export function renderCatchup(brief: CatchupBrief): string {
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
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", ...sections, gaps, footer].filter((s) => s !== "").join("\n");
}

function renderGhostFinding(f: GhostFinding): string {
  const head = `**${f.expert ?? f.peerId}** (${f.rank}) — ${f.suggestedContact}`;
  if (f.context.length === 0) return `- ${head}`;
  const lines = f.context.slice(0, 5).map((c) => `   - ${c.title} (\`${c.service}\`)`);
  return [`- ${head}`, ...lines].join("\n");
}

export function renderGhost(brief: GhostBrief): string {
  const header = `# Ghost: ${brief.query.file}`;
  const body =
    brief.findings.length === 0
      ? "_no teammate context found_"
      : brief.findings.map(renderGhostFinding).join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}

function renderConflictFinding(f: ConflictFinding): string {
  return `- **${f.who ?? f.peerId}** — ${f.collisionType.replaceAll("_", " ")}: ${f.title} (\`${
    f.service
  }\`)`;
}

export function renderConflict(brief: ConflictBrief): string {
  const header = `# Conflicts: ${brief.query.file}`;
  const body =
    brief.collisions.length === 0
      ? "_no work-in-progress collisions found_"
      : brief.collisions.map(renderConflictFinding).join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}

export function renderHuddle(brief: HuddleBrief): string {
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
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", ...sections, gaps, footer].filter((s) => s !== "").join("\n");
}

export function renderJanitor(brief: JanitorBrief): string {
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
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", verdict, gaps, footer].filter((s) => s !== "").join("\n");
}

function preflightIcon(s: PreflightDownstream["status"]): string {
  if (s === "pass") return "✅ pass";
  if (s === "fail") return "❌ fail";
  if (s === "declined") return "⏸ declined";
  return "⚠ not configured";
}

export function renderPreflight(brief: PreflightBrief): string {
  const header = `# Preflight: ${brief.query.ref}`;
  const body =
    brief.downstreams.length === 0
      ? "_no downstream owners reachable_"
      : brief.downstreams
          .map((d) => `- **${d.who ?? d.peerId}**: ${preflightIcon(d.status)} — ${d.summary}`)
          .join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
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
  if (brief.subject === null) {
    return `_Could not resolve \`${brief.query.ref}\` to an indexed location._`;
  }
  const lineSuffix = brief.subject.lineNo === null ? "" : `:${String(brief.subject.lineNo)}`;
  return `\`${brief.subject.filePath}${lineSuffix}\` in \`${brief.subject.repoRoot}\``;
}

export function renderWhy(brief: WhyBrief): string {
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
  const gaps = renderGaps(brief.gaps);
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

/** Labels a definition that was not synthesized by an LLM, so the reader can weigh it. */
function renderGlossaryProvenance(source: GlossaryEntry["definitionSource"]): string[] {
  if (source === "snippet") {
    return ["- _Definition quoted verbatim from a source; no LLM configured._"];
  }
  if (source === "manual") {
    return ["- _Authored in `nimbus.toml`; not derived from indexed sources._"];
  }
  return [];
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
    ...renderGlossaryProvenance(e.definitionSource),
    ...renderGlossarySources(e.topSources),
  );
  return lines;
}

/** `list` mode: one bullet per term, ranked by the caller. */
function renderGlossaryList(entries: GlossaryEntry[]): string[] {
  if (entries.length === 0) return ["\n_No terms extracted yet._"];
  const rows = entries.map((e) => {
    const suffix = e.definitionSource === "manual" ? " — authored" : "";
    return `- **${e.term}** — ${String(e.docFreq)} mention(s)${suffix}`;
  });
  return ["", ...rows];
}

function renderGlossaryBody(brief: GlossaryBrief): string[] {
  if (brief.mode === "miss") return renderGlossaryMiss(brief);
  if (brief.mode === "term") {
    const e = brief.entries[0];
    return e === undefined ? [] : renderGlossaryEntry(brief, e);
  }
  return renderGlossaryList(brief.entries);
}

export function renderGlossary(brief: GlossaryBrief): string {
  const lines: string[] = ["# Glossary", ...renderGlossaryBody(brief)];
  const gaps = renderGaps(brief.gaps);
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

export function renderOwnership(brief: OwnershipBrief): string {
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
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
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

export function renderDecisions(brief: DecisionsBrief): string {
  const days = decisionsWindowDays(brief.generatedAt, brief.query.sinceMs);
  const header = `## Decisions · ${String(days)}d · ${String(brief.entries.length)} found`;
  const body =
    brief.entries.length === 0
      ? "_No decisions found._"
      : brief.entries.map((e) => renderDecisionsEntry(brief, e)).join("\n\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
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

export function renderPremortem(brief: PremortemBrief): string {
  const header = `# Pre-mortem: ${brief.query.epicRef}`;
  const sections: string[] = [];

  if (brief.epic !== null) {
    sections.push(`_${brief.epic.key} — ${brief.epic.title}_`);
  }

  if (brief.services.length > 0) {
    sections.push(`\n## Services\n\n${brief.services.map((s) => `- ${s}`).join("\n")}`);
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

  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", ...sections, gaps, footer].filter((s) => s !== "").join("\n");
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
 * A `null` lane means "could not be computed" (failed, or never attempted for lack of a
 * resolved subject) and must never render as `0` — that distinction is the entire reason
 * `authoredPrs` is nullable rather than defaulting to an all-zero object.
 */
function renderNegotiateAuthoredPrs(a: NegotiateAuthoredPrs | null): string {
  if (a === null) {
    return ["## PRs authored", "", "_could not be computed_"].join("\n");
  }
  const lines = ["## PRs authored", "", `- ${String(a.count)} PR(s), ${String(a.merged)} merged`];
  if (a.stats === null) {
    lines.push("- stats: not available (no enriched PR in this window)");
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
  return lines.join("\n");
}

/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateReviewedPrs(r: NegotiateReviewedPrs | null): string {
  if (r === null) {
    return ["## PRs reviewed", "", "_could not be computed_"].join("\n");
  }
  const lines = [
    "## PRs reviewed",
    "",
    `- ${String(r.count)} review(s): ${String(r.approved)} approved, ${String(
      r.changesRequested,
    )} changes requested, ${String(r.otherOrUnknown)} other/unknown`,
  ];
  return lines.join("\n");
}

/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateTickets(t: NegotiateTickets | null): string {
  if (t === null) {
    return ["## Tickets", "", "_could not be computed_"].join("\n");
  }
  const lines = [
    "## Tickets",
    "",
    `- ${String(t.opened)} opened, ${String(t.closedByAuthoredPr)} closed by an authored PR`,
  ];
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
    return ["## Ownership", "", "_could not be computed_"].join("\n");
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
  if (o.truncated) {
    lines.push("- list truncated at the display limit — more owned paths exist");
  }
  if (o.unmappedIdentitiesInIndex > 0) {
    lines.push(
      `- ${String(o.unmappedIdentitiesInIndex)} git identities in this index are not mapped ` +
        "to a person; ownership attributed to them is not counted here.",
    );
  }
  return lines.join("\n");
}

/**
 * Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. Same
 * disambiguation problem as `renderNegotiateOwnership`'s `unmappedIdentitiesInIndex`
 * (Task 4): `unattributable` is a fact about the INDEX (decisions mined from a source —
 * Obsidian, Teams — that records no author at all, or whose author is someone other than
 * the subject), never an attribution to the subject. Printed next to `authored` with no
 * disambiguating text, a reader (or their manager) could misread "N authored, M
 * unattributable" as "N + M decisions, M just not linked to me" — the undercount failure
 * inverted into an overstatement, which is worse (spec § 8.2, Task 5 fix-round-1). The
 * line must therefore read as "N decisions attributed to you; M decisions exist in the
 * index with no attributable author, not counted above and not necessarily yours" —
 * matching `renderNegotiateOwnership`'s "attributed to them is not counted here" phrasing.
 */
function renderNegotiateDecisions(d: NegotiateDecisions | null): string {
  if (d === null) {
    return ["## Decisions", "", "_could not be computed_"].join("\n");
  }
  const lines = [
    "## Decisions",
    "",
    `- ${String(d.authored)} decision(s) attributed to you`,
    `- ${String(d.unattributable)} decision(s) in this index have no indexed author and are ` +
      "not counted above — they are not necessarily yours",
  ];
  return lines.join("\n");
}

/**
 * Task 1's version rendered only the subject, the window and generation time, the gap
 * notes, and the unconditional `unavailableEvidence` list. Task 2 added the authored/
 * reviewed PR lane sections; Task 3 adds the tickets lane; Task 4 adds ownership; Task 5
 * adds decisions — a lane whose field is `null` renders as "could not be computed", never
 * as `0`; each later lane task extends this further the same way.
 */
export function renderNegotiate(brief: NegotiateBrief): string {
  const days = Math.round(brief.query.sinceMs / 86_400_000);
  const header = "# Negotiation brief";
  const subjectLine = renderNegotiateSubjectLine(brief.subject);
  const windowLine = `_window: last ${String(days)}d · generated ${new Date(
    brief.generatedAt,
  ).toISOString()}_`;
  const authoredPrs = renderNegotiateAuthoredPrs(brief.authoredPrs);
  const reviewedPrs = renderNegotiateReviewedPrs(brief.reviewedPrs);
  const tickets = renderNegotiateTickets(brief.tickets);
  const ownership = renderNegotiateOwnership(brief.ownership);
  const decisions = renderNegotiateDecisions(brief.decisions);
  const evidence = [
    "## Evidence not available from the index",
    "",
    ...brief.unavailableEvidence.map((e) => `- ${e}`),
  ].join("\n");
  const gaps = renderGaps(brief.gaps);
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
    ownership,
    "",
    decisions,
    "",
    evidence,
    gaps,
    footer,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
