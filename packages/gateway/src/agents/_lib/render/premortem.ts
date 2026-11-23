import type { Risk } from "../../../premortem/risks.ts";
import type { WatcherProposal } from "../../../premortem/watcher-proposals.ts";
import type { PremortemBrief } from "../premortem-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { assembleBrief } from "./_shared.ts";

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
  const label = w.riskKind === "deploy_failure" ? "failed deploys" : "incidents";
  if (w.state === "suppressed") {
    return (
      `- ${w.service} (${label}) — suppressed (id \`${w.watcherId}\`); this watcher was deliberately ` +
      `deleted on a previous run. Re-create it with \`nimbus pre-mortem ${epicRef} --repropose\`.`
    );
  }
  const stateLabel = w.state === "created" ? "created" : "already present";
  return (
    `- ${w.service} (${label}) — ${stateLabel} (id \`${w.watcherId}\`, paused). ` +
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
    const noun = brief.epic?.tracker === "linear" ? "projects" : "epics";
    sections.push(
      `\n## Comparable ${noun} (${String(brief.cohort.members.length)})\n\n${rows.join("\n")}`,
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
