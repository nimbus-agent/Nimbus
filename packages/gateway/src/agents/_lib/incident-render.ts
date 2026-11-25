import type { CascadeGroup, CascadeMember, CascadeReason } from "../../incident/cascade.ts";
import type { CascadeInfo } from "../../incident/cascade-read.ts";
import type {
  ChangeLane,
  ChatLane,
  ConcurrentLane,
  DataLane,
  DataTestView,
  Freshness,
  HistoryLane,
  IncidentRecordV1,
  OnCallLane,
  PriorLane,
  TimeValue,
  TriggerBlock,
} from "../../incident/incident-record-types.ts";
import type { Timeline } from "../../incident/timeline.ts";
import { schemaChangeLines } from "./incident-schema-lines.ts";
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

export const plain = (s: string): string => hardenedPlain(s, PLAIN_MAX);

export function section(title: string, lines: readonly string[]): string {
  return [`## ${title}`, "", ...lines].join("\n");
}

/** `" (as reported: <raw>)"` when the source's own spelling is worth showing, else "". */
function asReported(raw: string | null): string {
  return raw === null ? "" : ` (as reported: ${plain(raw)})`;
}

function severityText(t: TriggerBlock): string {
  if (t.severity === null) return "not reported";
  const raw = t.severityRaw === t.severity ? null : t.severityRaw;
  return plain(t.severity) + asReported(raw);
}

export function summaryLines(t: TriggerBlock): string[] {
  const lines = [
    `- Source: ${t.service} (${t.type}), id \`${plain(t.providerId)}\``,
    `- Severity: ${severityText(t)}`,
    `- Status: ${t.status}${asReported(t.statusRaw)}`,
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

export function serviceLines(r: IncidentRecordV1): string[] {
  const b = r.binding;
  if (b.bound)
    return [`- Bound to \`${plain(b.service ?? "")}\` (through ${b.via ?? "a binding"})`];
  return [`- Not bound to a configured service (${b.unboundReason ?? "unknown"}).`];
}

function skippedLine(skipped: string): string {
  return `_Skipped: ${skipped === "unbound" ? "no bound service" : "no open time"}._`;
}

function deploymentLines(c: ChangeLane): string[] {
  const d = c.deployment;
  if (d === null) return ["_No change candidate within the window._"];
  const lines = [
    `- Change candidate, the last deployment before the alert: ${hardenedTitleLink(d.title, d.url)} - ${String(d.minutesBeforeOpen)} min before, ${plain(d.environment)}, ${plain(d.conclusion)}, commit \`${plain(d.sha.slice(0, 12))}\` (timing only, not a proven cause; rule: ${d.rule})`,
  ];
  if (c.graphCorrelated !== null) {
    lines.push(
      `- Graph correlation: ${c.graphCorrelated ? "the graph also links this deployment to the alert" : "no graph link between this deployment and the alert"}`,
    );
  }
  return lines;
}

function prLine(p: NonNullable<ChangeLane["pr"]>): string {
  const stat =
    p.additions === null && p.deletions === null
      ? ""
      : ` (+${String(p.additions ?? 0)} -${String(p.deletions ?? 0)}, ${String(p.changedFiles ?? 0)} files)`;
  const merged = p.mergedAtMs === null ? "" : `, merged ${utcLabel(p.mergedAtMs)}`;
  return `- Pull request: ${hardenedTitleLink(p.title, p.url)}${merged}${stat} (rule: ${p.rule})`;
}

function ciLine(ci: NonNullable<ChangeLane["ci"]>): string {
  const conclusion = ci.conclusion === null ? "no conclusion recorded" : plain(ci.conclusion);
  return `- CI run: ${hardenedTitleLink(ci.title, ci.url)}, ${conclusion} (rule: ${ci.rule})`;
}

export function changeLines(c: ChangeLane): string[] {
  if (c.skipped !== null) return [skippedLine(c.skipped)];
  const lines = deploymentLines(c);
  if (c.pr !== null) lines.push(prLine(c.pr));
  if (c.ci !== null) lines.push(ciLine(c.ci));
  return lines;
}

/** A list the size cap emptied while its true total survived: never say "none" when there were some. */
function omittedForSize(total: number): string {
  return `_${String(total)} found; none shown, omitted to keep this record within its size limit._`;
}

function chatLines(c: ChatLane): string[] {
  if (c.skipped !== null) return [skippedLine(c.skipped)];
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

function priorClosedText(i: PriorLane["incidents"][number]): string {
  if (i.status !== "closed") return `, ${i.status}`;
  if (i.closedAtMs === null) return ", closed, time not recorded";
  return `, closed ${utcLabel(i.closedAtMs)} (${i.closedBasis})`;
}

function priorActedText(actions: number): string {
  if (actions <= 0) return "";
  const plural = actions === 1 ? "" : "s";
  return `, ${String(actions)} Nimbus action${plural} run on it`;
}

export function priorLines(p: PriorLane): string[] {
  if (p.skipped !== null) return [skippedLine(p.skipped)];
  if (p.incidents.length === 0) {
    return p.total > 0 ? [omittedForSize(p.total)] : ["_No earlier incident on this service._"];
  }
  const rows = p.incidents.map((i) => {
    const closed = priorClosedText(i);
    const acted = priorActedText(i.actions);
    return `- ${hardenedTitleLink(i.title, i.url)} - ${plain(i.service)}, opened ${i.openedAtMs === null ? "at an unknown time" : utcLabel(i.openedAtMs)}${closed}${acted} (rule: ${i.rule})`;
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

export function onCallLines(o: OnCallLane): string[] {
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

export function concurrentLines(c: ConcurrentLane): string[] {
  if (c.skipped !== null) return ["_Skipped: no open time._"];
  if (c.records.length === 0) {
    return c.total > 0 ? [omittedForSize(c.total)] : ["_No other open record within 30 minutes._"];
  }
  const rows = c.records.map((r) => {
    const severity = r.severity === null ? "" : ` ${plain(r.severity)}`;
    const service = r.service === null ? "unbound" : plain(r.service);
    return `- ${codeSpan(r.recordId)} ${plain(r.source)}${severity}, ${service}, opened ${utcLabel(r.openedAtMs)} (rule: ${r.rule})`;
  });
  const more = c.total - c.records.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

/** One dbt test line: status and counts and the model, never SQL or rows. */
export function dbtTestLine(t: DataTestView): string {
  const failing = t.failures === null ? "" : `, ${String(t.failures)} failing`;
  const where = t.via === "monitored" ? "on" : "on an upstream model,";
  return `- dbt test ${hardenedTitleLink(t.title, t.url)}: ${t.status}${failing}, ${where} \`${plain(t.model)}\`, ${utcLabel(t.atMs)} (rule: ${t.rule})`;
}

function codeSpan(s: string): string {
  return `\`${plain(s)}\``;
}

function dataLines(d: DataLane): string[] {
  const lines: string[] = [];
  const models = d.models.map(codeSpan).join(", ");
  lines.push(d.models.length === 0 ? "_No monitored table._" : `- Monitored: ${models}`);
  for (const l of d.lineage)
    lines.push(`- Upstream of \`${plain(l.model)}\`: \`${plain(l.to)}\` (rule: ${l.rule})`);
  for (const o of d.orchestration)
    lines.push(
      `- Job by name: ${hardenedTitleLink(o.title, o.url)} - ${plain(o.service)} (rule: ${o.rule})`,
    );
  for (const t of d.dbtTests ?? []) lines.push(dbtTestLine(t));
  for (const p of d.prs) {
    const at = p.atMs === null ? "" : `, ${utcLabel(p.atMs)}`;
    lines.push(`- Merged change: ${hardenedTitleLink(p.title, p.url)}${at} (rule: ${p.rule})`);
  }
  if (d.schemaDiff !== undefined && d.schemaDiff.total > 0) {
    lines.push(...schemaChangeLines(d.schemaDiff, { plain, utc: utcLabel }));
  }
  const t = d.totals;
  const hidden =
    t.lineage -
    d.lineage.length +
    (t.orchestration - d.orchestration.length) +
    (t.prs - d.prs.length) +
    ((t.dbtTests ?? 0) - (d.dbtTests ?? []).length);
  if (hidden > 0) lines.push(`_and ${String(hidden)} more_`);
  return lines;
}

export function historyLines(h: HistoryLane): string[] {
  if (h.rows.length === 0) return ["_No recorded state change._"];
  const rows = h.rows.map(
    (r) =>
      `- ${utcLabel(r.observedAtMs)}: ${plain(r.key)} ${r.from === null ? "(none)" : plain(r.from)} -> ${r.to === null ? "(none)" : plain(r.to)} (observed)`,
  );
  return h.truncated > 0 ? [...rows, `_and ${String(h.truncated)} more_`] : rows;
}

/** The reserved `## Data freshness` block, built from the record's own freshness ("" when it has none). */
function freshnessState(r: Freshness["rows"][number]): string {
  if (!r.connected) return "not connected";
  if (r.lastSyncMs === null) return "connected, never synced";
  return `last synced ${utcLabel(r.lastSyncMs)}`;
}

export function renderIncidentFreshness(f: Freshness): string {
  const lines: string[] = f.rows.map((r) => `- ${plain(r.service)}: ${freshnessState(r)}`);
  if (f.onCallStale === true) lines.push("- on-call data: older than 60 minutes");
  if (f.chatToMs !== null) lines.push(`- chat searched up to ${utcLabel(f.chatToMs)}`);
  if (lines.length === 0) return "";
  return [INCIDENT_FRESHNESS_HEADING, "", ...lines].join("\n");
}

/** `YYYY-MM-DD HH:MM:SS UTC`: the timeline keeps seconds, so events a minute apart keep their order. */
export function utcSecondsLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * The timeline of one record (Phase 10 IC4): deterministic, no model, zone-free. Each line names its clock
 * (`source` or `observed`) and its event kind; the text is provider-influenced and goes through
 * `hardenedPlain`, so a title can neither forge a heading nor open a link. `## Timeline` is an ordinary section
 * of a view, never a reserved heading of the incident brief (I31 is not engaged: nothing here is synthesized).
 */
export function renderTimeline(timeline: Timeline): string {
  const lines =
    timeline.events.length === 0
      ? ["_No event to show._"]
      : timeline.events.map(
          (e) => `- ${utcSecondsLabel(e.atMs)} (${e.atBasis}) ${e.kind}: ${plain(e.text)}`,
        );
  const notes = timeline.notes.map((n) => `- ${plain(n)}`);
  const sections = [section("Timeline", lines)];
  if (notes.length > 0) sections.push(section("Notes", notes));
  return sections.join("\n\n");
}

function cascadeReasonText(m: CascadeMember): string {
  const r: CascadeReason = m.reason;
  switch (r.kind) {
    case "declared_dependency":
      return r.path === undefined
        ? dependentsText(r.dependents)
        : `depends on the root through ${r.path.map(plain).join(" -> ")} (declared depends_on)`;
    case "shared_deployment":
      return "cites the same deployment as the root";
    case "time_only":
      return timeOnlyText(m.role, r.minutesAfterRoot);
  }
}

function dependentsText(dependents: number): string {
  const plural = dependents === 1 ? "" : "s";
  return `${String(dependents)} other open record${plural} in this window run on a service that depends on this one (declared depends_on)`;
}

function timeOnlyText(role: CascadeMember["role"], minutesAfterRoot: number): string {
  if (role === "root") return "ranked by open time (no declared dependency decides it)";
  if (minutesAfterRoot < 0)
    return `no declared path to the root; opened ${String(-minutesAfterRoot)} min before it`;
  return `no declared path to the root; opened ${String(minutesAfterRoot)} min after it`;
}

function cascadeMemberLabel(m: CascadeMember, i: CascadeInfo | undefined): string {
  if (i === undefined) return `record ${codeSpan(m.recordId)}`;
  const service = i.service === null ? "" : `, ${plain(i.service)}`;
  return `${hardenedPlain(i.title, PLAIN_MAX)} (${plain(i.source)}${service}, opened ${utcLabel(i.openedAtMs)})`;
}

function cascadeMemberLine(m: CascadeMember, info: ReadonlyMap<string, CascadeInfo>): string {
  const label = cascadeMemberLabel(m, info.get(m.recordId));
  const role = m.role === "root" ? "Root candidate" : "Downstream";
  return `- ${role}: ${label}: ${cascadeReasonText(m)}`;
}

/**
 * The cascade block of one record (Phase 10 IC4, spec § 5.4): where this record stands among the open records
 * that opened within 30 minutes of one another. Deterministic and model-free; wording is D-IC-2 (a ranked
 * root CANDIDATE, never a proven cause). Appended to a PUSHED brief and shown by `incident show` after the
 * stored Markdown; it never enters the stored record and never passes through `synthesize()` (I31 is not
 * engaged), so `## Cascade` is not a reserved heading of the incident brief.
 */
export function renderCascadeSection(
  group: CascadeGroup,
  thisRecordId: string,
  info: ReadonlyMap<string, CascadeInfo>,
  /** True when more records are open than the ranking reads: the group and its root may be incomplete. */
  truncated = false,
): string {
  const me = group.members.find((m) => m.recordId === thisRecordId);
  const root = group.members.find((m) => m.role === "root");
  const rootInfo = root === undefined ? undefined : info.get(root.recordId);
  const rootName =
    rootInfo === undefined
      ? "the root candidate"
      : `\`${hardenedPlain(rootInfo.title, PLAIN_MAX).replaceAll("`", "")}\``;
  const headline =
    me?.role === "root"
      ? `- This record is the ranked root candidate of ${String(group.members.length)} open records that opened within 30 minutes of one another.`
      : `- This record is downstream of ${rootName}, the ranked root candidate of ${String(group.members.length)} open records that opened within 30 minutes of one another.`;
  const lines = [
    headline,
    `- Ranking: ${group.relationLabel}. It ranks candidates; it does not prove a cause.`,
    ...(group.reachCapped
      ? [
          "- The dependency graph was too large to search completely; some relations were treated as absent.",
        ]
      : []),
    ...(truncated
      ? [
          "- More than 500 records are open; the oldest were left out of this ranking, so this group and its root may be incomplete.",
        ]
      : []),
    ...group.members.map((m) => cascadeMemberLine(m, info)),
  ];
  return section("Cascade", lines);
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
