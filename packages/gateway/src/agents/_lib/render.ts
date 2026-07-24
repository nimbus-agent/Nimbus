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
