import type {
  ChangeLane,
  ChatLane,
  ConcurrentLane,
  DataLane,
  Freshness,
  HistoryLane,
  IncidentRecordV1,
  OnCallLane,
  PriorLane,
  TimeValue,
  TriggerBlock,
} from "../../incident/incident-record-types.ts";
import type { IncidentBrief } from "./incident-types.ts";
import { hardenedPlain, hardenedTitleLink, type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of an incident record (Phase 10 IC3; OR-10-8: no model anywhere in it). Zone-free:
 * every time is UTC (`YYYY-MM-DD HH:MM UTC`), so the Markdown is byte-identical across machines. Every
 * provider-supplied string goes through `hardenedTitleLink` or `hardenedPlain`; fixed text is ours.
 *
 * Wording follows D-IC-2: a deployment is "the last deployment before the alert" with its distance and the
 * words "timing only, not a proven cause"; an entry is a "candidate", never a "root cause".
 */

export const INCIDENT_FRESHNESS_HEADING = "## Data freshness";

const PLAIN_MAX = 120;

export function utcLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function timeText(t: TimeValue, noneText: string): string {
  return t.ms === null ? noneText : `${utcLabel(t.ms)} (${t.basis})`;
}

const plain = (s: string): string => hardenedPlain(s, PLAIN_MAX);

function section(title: string, lines: readonly string[]): string {
  return [`## ${title}`, "", ...lines].join("\n");
}

function summaryLines(t: TriggerBlock): string[] {
  const lines = [
    `- Source: ${t.service} (${t.type}), id \`${plain(t.providerId)}\``,
    `- Severity: ${t.severity === null ? "not reported" : `${plain(t.severity)}${t.severityRaw !== null && t.severityRaw !== t.severity ? ` (as reported: ${plain(t.severityRaw)})` : ""}`}`,
    `- Status: ${t.status}${t.statusRaw === null ? "" : ` (as reported: ${plain(t.statusRaw)})`}`,
    `- Opened: ${timeText(t.opened, "not recorded by the source")}`,
  ];
  if (t.status === "closed") {
    lines.push(`- Closed: ${timeText(t.closed, "closed, time not recorded")}`);
  }
  if (t.opened.ms === null && t.firstObservedMs !== null) {
    lines.push(`- First observed by Nimbus: ${utcLabel(t.firstObservedMs)} (observed)`);
  }
  if (t.assigneeCount !== null) lines.push(`- Assigned: ${String(t.assigneeCount)}`);
  if (t.slaStatus !== null) lines.push(`- SLA status: ${plain(t.slaStatus)}`);
  return lines;
}

function serviceLines(r: IncidentRecordV1): string[] {
  const b = r.binding;
  if (b.bound)
    return [`- Bound to \`${plain(b.service ?? "")}\` (through ${b.via ?? "a binding"})`];
  return [`- Not bound to a configured service (${b.unboundReason ?? "unknown"}).`];
}

function changeLines(c: ChangeLane): string[] {
  if (c.skipped !== null)
    return [`_Skipped: ${c.skipped === "unbound" ? "no bound service" : "no open time"}._`];
  const lines: string[] = [];
  const d = c.deployment;
  if (d === null) {
    lines.push("_No change candidate within the window._");
  } else {
    lines.push(
      `- Change candidate, the last deployment before the alert: ${hardenedTitleLink(d.title, d.url)} - ${String(d.minutesBeforeOpen)} min before, ${plain(d.environment)}, ${plain(d.conclusion)}, commit \`${plain(d.sha.slice(0, 12))}\` (timing only, not a proven cause; rule: ${d.rule})`,
    );
    if (c.graphCorrelated !== null) {
      lines.push(
        `- Graph correlation: ${c.graphCorrelated ? "the graph also links this deployment to the alert" : "no graph link between this deployment and the alert"}`,
      );
    }
  }
  if (c.pr !== null) {
    const p = c.pr;
    const stat =
      p.additions === null && p.deletions === null
        ? ""
        : ` (+${String(p.additions ?? 0)} -${String(p.deletions ?? 0)}, ${String(p.changedFiles ?? 0)} files)`;
    lines.push(
      `- Pull request: ${hardenedTitleLink(p.title, p.url)}${p.mergedAtMs === null ? "" : `, merged ${utcLabel(p.mergedAtMs)}`}${stat} (rule: ${p.rule})`,
    );
  }
  if (c.ci !== null) {
    lines.push(
      `- CI run: ${hardenedTitleLink(c.ci.title, c.ci.url)}, ${c.ci.conclusion === null ? "no conclusion recorded" : plain(c.ci.conclusion)} (rule: ${c.ci.rule})`,
    );
  }
  return lines;
}

/** A list the size cap emptied while its true total survived: never say "none" when there were some. */
function omittedForSize(total: number): string {
  return `_${String(total)} found; none shown, omitted to keep this record within its size limit._`;
}

function chatLines(c: ChatLane): string[] {
  if (c.skipped !== null)
    return [`_Skipped: ${c.skipped === "unbound" ? "no bound service" : "no open time"}._`];
  if (c.messages.length === 0) {
    return c.total > 0 ? [omittedForSize(c.total)] : ["_No matching message._"];
  }
  const rows = c.messages.map(
    (m) =>
      `- ${hardenedTitleLink(m.title, m.url)} - ${plain(m.service)}, ${utcLabel(m.atMs)} (rule: ${plain(m.rule)})`,
  );
  const more = c.total - c.messages.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

function priorLines(p: PriorLane): string[] {
  if (p.skipped !== null)
    return [`_Skipped: ${p.skipped === "unbound" ? "no bound service" : "no open time"}._`];
  if (p.incidents.length === 0) {
    return p.total > 0 ? [omittedForSize(p.total)] : ["_No earlier incident on this service._"];
  }
  const rows = p.incidents.map((i) => {
    const closed =
      i.status === "closed"
        ? i.closedAtMs === null
          ? ", closed, time not recorded"
          : `, closed ${utcLabel(i.closedAtMs)} (${i.closedBasis})`
        : `, ${i.status}`;
    return `- ${hardenedTitleLink(i.title, i.url)} - ${plain(i.service)}, opened ${i.openedAtMs === null ? "at an unknown time" : utcLabel(i.openedAtMs)}${closed} (rule: ${i.rule})`;
  });
  const more = p.total - p.incidents.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

function personText(p: OnCallLane["current"][number]): string {
  const who = p.userName === null ? "someone" : plain(p.userName);
  const where = p.scheduleName === null ? "" : ` on ${plain(p.scheduleName)}`;
  const until = p.endMs === null ? "" : ` until ${utcLabel(p.endMs)}`;
  return `${who}${p.isMe ? " (you)" : ""}${where}${until}`;
}

function onCallLines(o: OnCallLane): string[] {
  switch (o.status) {
    case "skipped":
      return ["_Not looked up: no bound service._"];
    case "no_data":
      return ["_No on-call shifts are indexed; who is on call is unknown._"];
    case "no_match":
      return ["_No on-call schedule is indexed for this service._"];
    case "none_on_call":
      return [
        "_Nobody is on call now according to the index._",
        ...o.next.map((p) => `- Next: ${personText(p)}`),
      ];
    case "ok":
      return [
        ...o.current.map((p) => `- On call: ${personText(p)}`),
        ...o.next.map((p) => `- Next: ${personText(p)}`),
        ...(o.resolvedVia === null ? [] : [`_Matched by ${o.resolvedVia} (rule: ${o.rule})._`]),
      ];
  }
}

function concurrentLines(c: ConcurrentLane): string[] {
  if (c.skipped !== null) return ["_Skipped: no open time._"];
  if (c.records.length === 0) {
    return c.total > 0 ? [omittedForSize(c.total)] : ["_No other open record within 30 minutes._"];
  }
  const rows = c.records.map(
    (r) =>
      `- \`${plain(r.recordId)}\` ${plain(r.source)}${r.severity === null ? "" : ` ${plain(r.severity)}`}, ${r.service === null ? "unbound" : plain(r.service)}, opened ${utcLabel(r.openedAtMs)} (rule: ${r.rule})`,
  );
  const more = c.total - c.records.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

function dataLines(d: DataLane): string[] {
  const lines: string[] = [];
  lines.push(
    d.models.length === 0
      ? "_No monitored table._"
      : `- Monitored: ${d.models.map((m) => `\`${plain(m)}\``).join(", ")}`,
  );
  for (const l of d.lineage)
    lines.push(`- Upstream of \`${plain(l.model)}\`: \`${plain(l.to)}\` (rule: ${l.rule})`);
  for (const o of d.orchestration)
    lines.push(
      `- Job by name: ${hardenedTitleLink(o.title, o.url)} - ${plain(o.service)} (rule: ${o.rule})`,
    );
  for (const p of d.prs)
    lines.push(
      `- Merged change: ${hardenedTitleLink(p.title, p.url)}${p.atMs === null ? "" : `, ${utcLabel(p.atMs)}`} (rule: ${p.rule})`,
    );
  const t = d.totals;
  const hidden =
    t.lineage -
    d.lineage.length +
    (t.orchestration - d.orchestration.length) +
    (t.prs - d.prs.length);
  if (hidden > 0) lines.push(`_and ${String(hidden)} more_`);
  return lines;
}

function historyLines(h: HistoryLane): string[] {
  if (h.rows.length === 0) return ["_No recorded state change._"];
  const rows = h.rows.map(
    (r) =>
      `- ${utcLabel(r.observedAtMs)}: ${plain(r.key)} ${r.from === null ? "(none)" : plain(r.from)} -> ${r.to === null ? "(none)" : plain(r.to)} (observed)`,
  );
  return h.truncated > 0 ? [...rows, `_and ${String(h.truncated)} more_`] : rows;
}

/** The reserved `## Data freshness` block, built from the record's own freshness ("" when it has none). */
export function renderIncidentFreshness(f: Freshness): string {
  const lines: string[] = f.rows.map(
    (r) =>
      `- ${plain(r.service)}: ${r.connected ? (r.lastSyncMs === null ? "connected, never synced" : `last synced ${utcLabel(r.lastSyncMs)}`) : "not connected"}`,
  );
  if (f.onCallStale === true) lines.push("- on-call data: older than 60 minutes");
  if (f.chatToMs !== null) lines.push(`- chat searched up to ${utcLabel(f.chatToMs)}`);
  if (lines.length === 0) return "";
  return [INCIDENT_FRESHNESS_HEADING, "", ...lines].join("\n");
}

export function renderIncident(brief: IncidentBrief, opts?: RenderOpts): string {
  const r = brief.record;
  const header = `# Incident ${hardenedTitleLink(r.trigger.title, r.trigger.url)}`;
  const body = [
    section("Summary", summaryLines(r.trigger)),
    section("Service", serviceLines(r)),
    section("Change", changeLines(r.change)),
    section("Chat", chatLines(r.chat)),
    section("Prior incidents", priorLines(r.prior)),
    section("On call", onCallLines(r.onCall)),
    section("Concurrent", concurrentLines(r.concurrent)),
    ...(r.data === null ? [] : [section("Data", dataLines(r.data))]),
    section("History", historyLines(r.history)),
  ];
  const withheld = opts?.omitReserved === true;
  const gaps = withheld ? "" : renderGaps(brief.gaps).trim();
  const freshness = withheld ? "" : renderIncidentFreshness(r.freshness);
  return [header, ...body, gaps, freshness].filter((s) => s !== "").join("\n\n");
}
