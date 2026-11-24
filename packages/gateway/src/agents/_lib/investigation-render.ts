import type { Investigation, Lead, SentryIssueRow } from "../../incident/investigate.ts";
import type { LiveIssueRow } from "../../incident/investigate-live-types.ts";
import { utcLabel } from "./incident-render.ts";
import { hardenedPlain, hardenedTitleLink } from "./render.ts";

/**
 * The deterministic render of an investigation (Phase 10 IC9a). No model touches it (OR-10-8): the brief is the
 * same bytes on every machine (UTC times, fixed order), and `## Gaps` then `## Data freshness` are always the last
 * two headings, emitted here and never left to a caller or a synthesizer to add (I31's "a brief never says less than
 * the deterministic render" holds because the deterministic render is the only render). Every provider-supplied
 * string goes through `hardenedTitleLink` or `hardenedPlain`; the fixed text is ours. Wording follows D-IC-2: an
 * entry is a "candidate" with its timing, never a cause.
 */

const PLAIN_MAX = 120;
const plain = (s: string): string => hardenedPlain(s, PLAIN_MAX);
const when = (ms: number | null, none: string): string => (ms === null ? none : utcLabel(ms));

function section(title: string, lines: readonly string[]): string {
  return [`## ${title}`, "", ...lines].join("\n");
}

export function summary(inv: Investigation): string {
  const t = inv.trigger;
  const lines = [
    `- Record: \`${plain(inv.recordId)}\` (version ${String(inv.version)})`,
    `- Trigger: ${hardenedTitleLink(t.title, t.url)} (${plain(t.service)} ${plain(t.type)})`,
    `- Status: ${plain(t.status)}, severity ${t.severity === null ? "not reported" : plain(t.severity)}`,
    `- Opened: ${when(t.openedAtMs, "not recorded by the source")}`,
    `- Service: ${inv.binding.service === null ? "not bound to a configured service" : `${plain(inv.binding.service)} (bound by ${inv.binding.via === null ? "an unknown rule" : plain(inv.binding.via)})`}`,
    `- Window read: ${utcLabel(inv.span.fromMs)} to ${utcLabel(inv.span.toMs)}`,
  ];
  return section("Summary", lines);
}

function sentryRow(r: SentryIssueRow): string {
  const facts = [
    `project ${plain(r.project)}`,
    r.level === null ? null : `level ${plain(r.level)}`,
    r.status === null ? null : `status ${plain(r.status)}`,
    r.count === null ? null : `${String(r.count)} events`,
    r.userCount === null ? null : `${String(r.userCount)} users`,
    r.firstSeenMs === null ? null : `first seen ${utcLabel(r.firstSeenMs)}`,
    `last seen ${utcLabel(r.lastSeenMs)}`,
    r.newSinceDeploy ? "first seen after the deployment started (timing only)" : null,
  ].filter((x): x is string => x !== null);
  return `- ${hardenedTitleLink(r.title, r.url)}: ${facts.join("; ")}`;
}

const LIVE_PROJECT_WORD: Readonly<Record<string, string>> = {
  read: "read",
  timeout: "timed out",
  refused: "refused",
  failed: "failed",
  unreadable: "unreadable reply",
  skipped_budget: "not read (budget spent)",
  skipped_cap: "not read (project cap)",
};

function liveRow(r: LiveIssueRow): string {
  const facts = [
    `project ${plain(r.project)}`,
    r.level === null ? null : `level ${plain(r.level)}`,
    r.status === null ? null : `status ${plain(r.status)}`,
    r.count === null ? null : `${String(r.count)} events`,
    r.userCount === null ? null : `${String(r.userCount)} users`,
    r.firstSeenMs === null ? null : `first seen ${utcLabel(r.firstSeenMs)}`,
    `last seen ${utcLabel(r.lastSeenMs)}`,
    r.newSinceDeploy ? "first seen after the deployment started (timing only)" : null,
  ].filter((x): x is string => x !== null);
  return `- ${hardenedTitleLink(r.title, r.url)}: ${facts.join("; ")}`;
}

/** The `--live` block: what Sentry itself answered now, correlated to the record by project and window. */
function liveSentry(inv: Investigation): string | null {
  const l = inv.live;
  if (l === undefined) return null;
  const lines = [
    `_Live read, not stored: ${l.projects.map((p) => `${plain(p.project)} ${LIVE_PROJECT_WORD[p.outcome] ?? "not read"}`).join(", ") || "no project was read"} (budget ${String(Math.round(l.budgetMs / 1000))} s)._`,
    ...l.rows.map(liveRow),
  ];
  if (l.status !== "not_read" && l.rows.length === 0) {
    lines.push(
      l.status === "ok"
        ? "_No unresolved issue of the bound projects was active in the window._"
        : "_No unresolved issue was active in the window in the projects that were read; the others were not read (see Gaps)._",
    );
  }
  if (l.total > l.rows.length) lines.push(`_and ${String(l.total - l.rows.length)} more_`);
  return section("Sentry error issues, live", lines);
}

export function sentry(inv: Investigation): string {
  const indexed = indexedSentry(inv.sentry);
  const live = liveSentry(inv);
  return live === null ? indexed : [indexed, live].join("\n\n");
}

function indexedSentry(s: Investigation["sentry"]): string {
  if (s.status !== "ok") return section("Sentry error issues", ["_Not listed; see Gaps._"]);
  const lines =
    s.rows.length === 0
      ? [`_No Sentry issue of ${s.projects.map(plain).join(", ")} was seen in the window._`]
      : s.rows.map(sentryRow);
  if (s.total > s.rows.length) lines.push(`_and ${String(s.total - s.rows.length)} more_`);
  return section("Sentry error issues", lines);
}

export function dataContext(inv: Investigation): string | null {
  const d = inv.data;
  if (d === null) return null;
  const lines = [
    `- Models: ${d.models.length === 0 ? "none" : d.models.map(plain).join(", ")}`,
    `- Lineage edges: ${String(d.totals.lineage)}; orchestration items: ${String(d.totals.orchestration)}; pull requests: ${String(d.totals.prs)}`,
    ...d.lineage.map((l) => `- ${plain(l.model)} <- ${plain(l.to)}`),
    ...d.orchestration.map(
      (o) => `- ${hardenedTitleLink(o.title, o.url)} (${plain(o.service)} ${plain(o.type)})`,
    ),
  ];
  return section("Data-quality context", lines);
}

export function related(inv: Investigation): string {
  const r = inv.relatedOpen;
  if (r.items.length === 0) {
    return section("Other open records of this service", ["_None._"]);
  }
  const lines = r.items.map(
    (x) =>
      `- \`${plain(x.recordId)}\` ${plain(x.source)} ${x.severity === null ? "" : `${plain(x.severity)} `}opened ${when(x.openedAtMs, "at an unknown time")}: ${plain(x.title)}`,
  );
  if (r.total > r.items.length) lines.push(`_and ${String(r.total - r.items.length)} more_`);
  return section("Other open records of this service", lines);
}

const ACTION_WORD: Readonly<Record<string, string>> = {
  action_approved: "approved",
  action_denied: "denied",
  action_undone: "undone",
};

export function actions(inv: Investigation): string {
  if (inv.actions.length === 0) {
    return section("What Nimbus did", ["_No Nimbus action is linked to this record._"]);
  }
  return section(
    "What Nimbus did",
    inv.actions.map(
      (a) => `- ${utcLabel(a.atMs)} ${ACTION_WORD[a.kind] ?? "recorded"}: ${plain(a.text)}`,
    ),
  );
}

export function leads(list: readonly Lead[]): string {
  if (list.length === 0) return section("Leads", ["_None found in the index._"]);
  return section(
    "Leads",
    list.map((l) => `- ${l.text} (\`${plain(l.refId)}\`)`),
  );
}

export function freshnessLines(inv: Investigation): string[] {
  const fresh = inv.freshness.map(
    (f) =>
      `- ${plain(f.service)}: ${f.connected ? (f.lastSyncMs === null ? "connected, never synced" : `last synced ${utcLabel(f.lastSyncMs)}`) : "not connected"}`,
  );
  fresh.push(`- Record assembled ${utcLabel(inv.recordAssembledAtMs)}`);
  fresh.push(`- Read at ${utcLabel(inv.asOfMs)}`);
  return fresh;
}

function tail(inv: Investigation): string[] {
  const gaps = inv.gaps.map((g) => `- ${g.detail}`);
  return [section("Gaps", gaps), section("Data freshness", freshnessLines(inv))];
}

export function renderInvestigation(inv: Investigation): string {
  const parts: (string | null)[] = [
    `# Investigation: ${plain(inv.trigger.title)}`,
    summary(inv),
    sentry(inv),
    dataContext(inv),
    related(inv),
    actions(inv),
    leads(inv.leads),
    ...tail(inv),
  ];
  return `${parts.filter((p): p is string => p !== null).join("\n\n")}\n`;
}
