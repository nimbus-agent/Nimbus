import { oncallDisclosures, windowLabel } from "../brief-disclosures.ts";
import type {
  OncallBrief,
  OncallChange,
  OncallIncident,
  OncallNowShift,
  OncallOnCallNow,
  OncallPriorIncident,
} from "../oncall-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { assembleBrief, isoMinuteUtc, plural } from "./_shared.ts";
import { renderEntrySection } from "./entries.ts";
import { hardenedTitleLink, stripLineStructureChars } from "./text.ts";

/**
 * `nimbus oncall` — one incident, and what the index can say about the change around it.
 *
 * A `#` title rather than `##`, for the reason `renderStandup` documents: `preambleBody`
 * (`markdown-sections.ts`) stops at the first LEVEL-2 heading, so under a level-2 title the
 * preamble would be empty and `contractViolations` could never reach the I31 disclosures that
 * live there — which on this brief includes the sync-freshness line qualifying the whole
 * selection.
 */
export function renderOncall(brief: OncallBrief, opts?: RenderOpts): string {
  const preamble = [
    "",
    `_incident: ${renderOncallIncidentLine(brief.incident)}_`,
    `_chat window: last ${windowLabel(brief.query.nowMs - brief.query.sinceMs)} (${isoMinuteUtc(brief.query.sinceMs)} → ${isoMinuteUtc(brief.query.nowMs)})_`,
    ...oncallDisclosures({
      syncAgeMs: brief.syncFreshness.ageMs,
      syncUnknown: brief.syncFreshness.reason !== null,
      hasDeployment: brief.deployment !== null,
      otherActiveCount: brief.otherActiveIncidents.length,
      assigneeScoped: brief.selection === "auto_assigned",
      truncatedCount: brief.truncatedCount,
    }).map((d) => d.line),
  ].join("\n");

  const sections = [
    renderOncallIncidentSection(brief),
    renderOncallDeploymentSection(brief),
    renderOncallChangeSection(brief),
    renderOncallCiSection(brief),
    renderEntrySection("Chat", brief.messages, isoMinuteUtc),
    renderOncallPriorSection(brief),
  ].join("\n");

  return assembleBrief("# On-call", [preamble, sections], brief, opts);
}

/** The incident as one preamble line: title, then the fact that decides how urgent it is. */
function renderOncallIncidentLine(i: OncallIncident): string {
  // `status unknown` rather than omitting the field: a missing status is WHY this incident counts
  // as active at all (`isActiveStatus` treats absent as active), so hiding it would leave the
  // reader unable to see why a row they do not recognise was selected.
  return `${hardenedTitleLink(i.title, i.url)} — ${i.status ?? "status unknown"}`;
}

function renderOncallIncidentSection(brief: OncallBrief): string {
  const i = brief.incident;
  const lines = [
    `- **Status:** ${i.status ?? "_not recorded_"}`,
    `- **Severity:** ${i.severity ?? "_not recorded_"}`,
    `- **Urgency:** ${i.urgency ?? "_not recorded_"}`,
    `- **Opened:** ${i.openedAtMs === null ? "_not recorded_" : isoMinuteUtc(i.openedAtMs)}`,
    `- **Assigned to:** ${
      i.assigneeEmails.length === 0
        ? "_nobody recorded_"
        : i.assigneeEmails.map((e) => stripLineStructureChars(e)).join(", ")
    }`,
    `- **Service:** ${oncallServiceLabel(brief)}`,
    `- **On call now:** ${renderOncallNow(brief)}`,
  ];

  // Named rather than only counted, so the reader can act on a runner-up without looking it up.
  //
  // The heading is derived from the SELECTION MODE, never fixed. `--service` selects on service
  // and status ALONE (`selectActiveIncidentsForPagerdutyServices` applies no assignee filter), so
  // "assigned to you" there is a plain falsehood about incidents that may belong to anyone.
  const others =
    brief.otherActiveIncidents.length === 0
      ? []
      : [
          "",
          `${oncallRunnerUpLabel(brief.selection)}:`,
          ...brief.otherActiveIncidents.map((o) => {
            // No url on a runner-up, so this is always the hardened PLAIN title.
            const title = hardenedTitleLink(o.title, null);
            const opened = o.openedAtMs === null ? "" : ` (opened ${isoMinuteUtc(o.openedAtMs)})`;
            return `- \`${stripLineStructureChars(o.id)}\` — ${title}${opened}`;
          }),
        ];

  return ["", "## Incident", "", ...lines, ...others].join("\n");
}

/**
 * What the runner-up incidents actually ARE, given how this brief selected its subject.
 *
 * Total over `OncallSelection` rather than a default arm, so a future selection mode is a compile
 * error here instead of silently inheriting a label that does not describe it. `explicit` never
 * reaches this — `selectIncident` returns no runner-ups for a named incident — but it is answered
 * anyway rather than thrown on, because a heading is not worth failing a brief over.
 */
function oncallRunnerUpLabel(selection: OncallBrief["selection"]): string {
  const LABELS: Readonly<Record<OncallBrief["selection"], string>> = {
    auto_assigned: "Other active incidents assigned to you",
    auto_service: "Other active incidents on this service",
    explicit: "Other active incidents",
  };
  return LABELS[selection];
}

/**
 * The service this incident maps to — or the reason it maps to nothing.
 *
 * An unmapped PagerDuty id is printed rather than swallowed, because it is the value the reader
 * has to paste into `nimbus.toml` to fix the four empty sections below, and `## Gaps` names the
 * remedy but cannot name the id without duplicating this lookup.
 */
const SOURCE_LABELS = { pagerduty: "PagerDuty", jsm: "Jira Service Management" } as const;

function renderNowShift(s: OncallNowShift): string {
  const parts: string[] = [];
  const where = s.scheduleName ?? s.policyName;
  if (where !== null) parts.push(hardenedTitleLink(where, null));
  if (s.level !== null) parts.push(`level ${String(s.level)}`);
  if (s.endMs !== null) parts.push(`until ${isoMinuteUtc(s.endMs)}`);
  const detail = parts.length === 0 ? "" : ` (${parts.join(", ")})`;
  return `${hardenedTitleLink(s.userName, null)}${detail}${s.isMe ? " (you)" : ""}`;
}

function renderNowAges(n: OncallOnCallNow): string {
  const out = n.sources.map((src) => {
    const label = SOURCE_LABELS[src.source];
    if (src.oldestFetchedMs === null)
      return `${label} data age unknown; the shift may have changed`;
    const minutes = Math.max(0, Math.round((n.asOfMs - src.oldestFetchedMs) / 60_000));
    const age = minutes >= 120 ? `${String(Math.round(minutes / 60))} h` : `${String(minutes)} min`;
    return `${label} data ${age} old${src.stale ? "; the shift may have changed" : ""}`;
  });
  return out.length === 0 ? "" : ` (${out.join("; ")})`;
}

/** The completeness warnings the query attached (an incomplete service map), shown with the result. */
function renderNowGaps(n: OncallOnCallNow): string {
  return n.gaps.length === 0 ? "" : ` ${n.gaps.map(stripLineStructureChars).join(" ")}`;
}

/** The on-call line of `## Incident`: explicit about every case, so an empty list never reads as "nobody". */
function renderOncallNow(brief: OncallBrief): string {
  const n = brief.onCallNow;
  if (n === null) return "_unknown (no service id)_";
  if (n.status === "no_data") return "_no on-call data indexed_";
  if (n.status === "no_match") {
    return `_no indexed schedule covers this service${renderNowAges(n)}_${renderNowGaps(n)}`;
  }
  if (n.status === "none_on_call") {
    const next = n.next.length === 0 ? "" : ` (next: ${n.next.map(renderNowShift).join("; ")})`;
    return `_nobody on call per the index${next}${renderNowAges(n)}_${renderNowGaps(n)}`;
  }
  return `${n.shifts.map(renderNowShift).join("; ")}${renderNowAges(n)}${renderNowGaps(n)}`;
}

function oncallServiceLabel(brief: OncallBrief): string {
  if (brief.binding.nimbusServiceId !== null) {
    return stripLineStructureChars(brief.binding.nimbusServiceId);
  }
  if (brief.binding.pagerdutyServiceId === null) return "_not recorded_";
  return `_unmapped (\`${stripLineStructureChars(brief.binding.pagerdutyServiceId)}\`)_`;
}

/**
 * The heading is "Last deployment before the alert", never "the deployment that caused it".
 *
 * The roadmap row asked for "the last deployment before the alert fired" and then for "the
 * triggering PR", and only the first is answerable: nothing in the index links a deployment to
 * an incident. The heading states the temporal claim and the preamble disclosure states its
 * limit; naming it a cause in either place would be the brief asserting a relationship it
 * derived from two timestamps.
 */
function renderOncallDeploymentSection(brief: OncallBrief): string {
  const d = brief.deployment;
  if (d === null) {
    return ["", "## Last deployment before the alert", "", "_None found._"].join("\n");
  }
  return [
    "",
    "## Last deployment before the alert",
    "",
    `- **Deployment:** ${hardenedTitleLink(d.title, d.workflowUrl)}`,
    `- **Started:** ${isoMinuteUtc(d.startedAtMs)}`,
    `- **Environment:** ${stripLineStructureChars(d.environment)}`,
    `- **Result:** ${stripLineStructureChars(d.conclusion)}`,
    `- **Commit:** \`${stripLineStructureChars(d.sha)}\``,
  ].join("\n");
}

/**
 * The change that shipped in that deployment — title and DIFFSTAT, never a diff.
 *
 * No connector indexes a patch, a changed-file list or a commit body, so three integers is the
 * whole of what can be honestly reported here. `## Gaps` says so unconditionally rather than
 * letting a size line read as a summary of what the change did.
 */
function renderOncallChangeSection(brief: OncallBrief): string {
  const c = brief.change;
  if (c === null) {
    return ["", "## Change in that deployment", "", "_None found._"].join("\n");
  }
  return [
    "",
    "## Change in that deployment",
    "",
    `- **Pull request:** ${hardenedTitleLink(c.title, c.url)}`,
    `- **Merged:** ${c.mergedAtMs === null ? "_not recorded_" : isoMinuteUtc(c.mergedAtMs)}`,
    `- **Size:** ${oncallChangeSize(c)}`,
  ].join("\n");
}

/**
 * The change's diffstat, or that it was not recorded.
 *
 * All three counts absent is a DIFFERENT statement from "+0 −0 across 0 files", which is a
 * legitimate value for an empty-commit deploy. Only the all-absent case is reported as unknown.
 */
function oncallChangeSize(c: OncallChange): string {
  if (c.additions === null && c.deletions === null && c.changedFiles === null) {
    return "_line counts not recorded_";
  }
  const files = c.changedFiles ?? 0;
  return (
    `+${String(c.additions ?? 0)} −${String(c.deletions ?? 0)} across ` +
    `${String(files)} ${plural(files, "file")}`
  );
}

function renderOncallCiSection(brief: OncallBrief): string {
  const r = brief.ciRun;
  if (r === null) return ["", "## CI", "", "_None found._"].join("\n");
  return [
    "",
    "## CI",
    "",
    `- **Run:** ${hardenedTitleLink(r.title, r.url)}`,
    `- **Result:** ${r.conclusion === null ? "_not recorded_" : stripLineStructureChars(r.conclusion)}`,
    `- **At:** ${isoMinuteUtc(r.atMs)}`,
  ].join("\n");
}

/**
 * Earlier incidents on the same service — who closed each and when, never HOW.
 *
 * The resolution narrative does not exist in the index (an incident's body is its status string),
 * so this lane's value is RECURRENCE: the count is the signal, and it is printed above the list
 * for that reason. `## Gaps` states the missing narrative unconditionally.
 */
function renderOncallPriorSection(brief: OncallBrief): string {
  const rows = brief.priorIncidents;
  if (rows.length === 0) {
    return ["", "## Prior incidents on this service", "", "_None found._"].join("\n");
  }
  const n = brief.counts.priorIncidents;
  // `counts.priorIncidents` SATURATES: `buildOncallBrief` over-fetches by exactly one past the
  // display cap, so a service with forty earlier incidents reports eleven. Printed as a bare
  // total that reads as exact — and recurrence is the one thing this lane exists to convey, so
  // understating it by 29 is the worst number on the page to get wrong. A count exceeding its own
  // listed length is precisely the saturated case (the cap makes the list shorter, never longer),
  // so it needs no constant import to detect.
  const saturated = n > rows.length;
  const summary = saturated
    ? `_At least ${String(n)} earlier incidents on this service — more than this brief counted._`
    : `_${String(n)} earlier ${plural(n, "incident")} on this service._`;
  const body = rows.map((p) => {
    const head = hardenedTitleLink(p.title, p.url);
    const opened = p.openedAtMs === null ? "date unknown" : isoMinuteUtc(p.openedAtMs);
    return `- ${head} — opened ${opened}, ${priorIncidentClosure(p)}`;
  });
  return ["", "## Prior incidents on this service", "", summary, "", ...body].join("\n");
}

/** Whether a prior incident is still open, or when it closed and — when recorded — by whom. */
function priorIncidentClosure(p: OncallPriorIncident): string {
  if (p.resolvedAtMs === null) {
    return p.closed ? "closed, time not recorded" : "still open";
  }
  const by = p.resolvedByEmail === null ? "" : ` by ${stripLineStructureChars(p.resolvedByEmail)}`;
  return `closed ${isoMinuteUtc(p.resolvedAtMs)}${by}`;
}
