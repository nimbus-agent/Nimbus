/**
 * The HTML renderer behind `nimbus statuspage draft`. Pure: a page model in, one self-contained HTML string
 * out (inline CSS, no script, no external resource of any kind).
 *
 * Every string that came from the model goes through `esc`, the ONE escaper in this file; markup is never
 * built from data, and the only attribute a value can reach is an `href` that passed `safeHref` and then
 * `esc`. The CLI cannot import gateway source, so the model is typed structurally here.
 */

export interface PageIncident {
  kind: "pagerduty_incident" | "jsm_alert";
  ref: string;
  status: string | null;
  severity: string | null;
  urgency: string | null;
  service: string | null;
  openedAtMs: number | null;
  title?: string;
  url?: string;
}
export interface PageSource {
  source: "pagerduty" | "jsm";
  indexed: boolean;
  lastSyncMs: number | null;
  stale: boolean;
  open: number;
}
export interface PageShift {
  source: "pagerduty" | "jsm";
  name: string | null;
  schedule: string | null;
  policy: string | null;
  level: number | null;
  startMs: number | null;
  endMs: number | null;
}
export interface PageDoraCell {
  value: number | null;
  unit: string;
  sample: number;
  gap: string | null;
}
export interface PageDoraRow {
  service: string;
  deployment_frequency: PageDoraCell;
  lead_time_for_changes: PageDoraCell;
  change_failure_rate: PageDoraCell;
  mttr: PageDoraCell;
}
export interface StatuspagePageModel {
  generatedAtMs: number;
  generatedAt: string;
  options: { services: string[]; titles: boolean; links: boolean };
  incidents: {
    status: "open" | "none_open" | "no_data";
    total: number;
    items: PageIncident[];
    sources: PageSource[];
  };
  onCall: {
    status: "ok" | "none_on_call" | "no_match" | "no_data";
    shifts: PageShift[];
    next: PageShift[];
    sources: { source: "pagerduty" | "jsm"; oldestFetchedMs: number | null; stale: boolean }[];
  };
  dora: { status: "ok" | "no_services" | "config_error"; windowDays: number; rows: PageDoraRow[] };
  gaps: string[];
}

export const DEFAULT_PAGE_TITLE = "Service status";

function isControlOrBidi(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * The one HTML escaper. Control, bidirectional-override and line-separator characters become a space
 * (they can reorder or hide text, and a newline inside an attribute is never wanted), then the five
 * characters that matter in element content AND in a quoted attribute are replaced, plus the backtick.
 */
export function esc(value: unknown): string {
  const s = typeof value === "string" ? value : String(value);
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (isControlOrBidi(code)) {
      out += " ";
      continue;
    }
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "`":
        out += "&#96;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** An http(s) URL, or undefined. Anything else (javascript:, data:, a relative path) is dropped. */
export function safeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function timeTag(ms: number | null): string {
  if (ms === null) return "unknown";
  return `<time datetime="${esc(new Date(ms).toISOString())}">${esc(utc(ms))}</time>`;
}

const SOURCE_LABEL = { pagerduty: "PagerDuty", jsm: "Jira Service Management" } as const;
const KIND_LABEL = { pagerduty_incident: "Incident", jsm_alert: "Alert" } as const;

const GAP_TEXT: Record<string, string> = {
  unknown_service: "service not configured",
  no_pagerduty_mapping: "no PagerDuty service is mapped",
  no_repos: "no repositories are bound",
  no_deployment_data: "no deployments were found",
  low_sample: "low sample",
  approximate_lead_time: "approximate",
  incomplete_merge_data: "some merge times are unknown",
  incomplete_resolution_data: "some resolution times are unknown",
  pr_labels_unavailable: "label filter could not apply to every change",
  mixed_source: "mixed sources",
  ci_not_evaluable: "the CI provider cannot be judged from the index",
};

function gapText(gap: string | null): string {
  if (gap === null) return "";
  return GAP_TEXT[gap] ?? gap.replaceAll("_", " ");
}

function duration(seconds: number): string {
  if (seconds < 90) return `${String(Math.round(seconds))} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${String(Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function formatValue(c: PageDoraCell): string {
  const v = c.value;
  if (v === null) return "";
  switch (c.unit) {
    case "deploys_per_day":
      return `${v.toFixed(2)} per day`;
    case "seconds_median":
      return `${duration(v)} (median)`;
    case "ratio":
      return `${(v * 100).toFixed(1)}%`;
    default:
      return `${String(v)} ${c.unit}`;
  }
}

function doraCell(c: PageDoraCell): string {
  if (c.value === null) {
    const why = gapText(c.gap);
    return `<td class="nodata">No data${why === "" ? "" : ` <span class="note">(${esc(why)})</span>`}</td>`;
  }
  const notes = [`n=${String(c.sample)}`];
  const why = gapText(c.gap);
  if (why !== "") notes.push(why);
  return `<td>${esc(formatValue(c))} <span class="note">(${esc(notes.join(", "))})</span></td>`;
}

function incidentRow(i: PageIncident, titles: boolean): string {
  const heading = `${KIND_LABEL[i.kind]} ${i.ref}`;
  const href = safeHref(i.url);
  const label = esc(heading);
  const ref =
    href === undefined ? label : `<a href="${esc(href)}" rel="noopener noreferrer">${label}</a>`;
  const title = titles && i.title !== undefined ? `<div class="title">${esc(i.title)}</div>` : "";
  const sev = [i.severity, i.urgency === null ? null : `${i.urgency} urgency`]
    .filter((x): x is string => x !== null)
    .join(", ");
  return (
    `<tr><td>${ref}${title}</td>` +
    `<td>${esc(i.status ?? "unknown")}</td>` +
    `<td>${esc(sev === "" ? "unknown" : sev)}</td>` +
    `<td>${esc(i.service ?? "unbound")}</td>` +
    `<td>${timeTag(i.openedAtMs)}</td></tr>`
  );
}

function incidentsSection(m: StatuspagePageModel): string {
  const inc = m.incidents;
  let body: string;
  if (inc.status === "no_data") {
    body =
      '<p class="unknown"><strong>Unknown:</strong> no incident data is indexed, so this page cannot say ' +
      "whether anything is open. Connect PagerDuty or Jira Service Management and let a sync run.</p>";
  } else if (inc.status === "none_open") {
    body = '<p class="ok"><strong>No open incidents</strong> in the indexed data.</p>';
  } else {
    body =
      `<table><thead><tr><th>Incident</th><th>Status</th><th>Severity</th><th>Service</th><th>Opened</th></tr></thead><tbody>` +
      `${inc.items.map((i) => incidentRow(i, m.options.titles)).join("")}</tbody></table>`;
    if (inc.total > inc.items.length) {
      body += `<p class="note">${esc(`Showing ${String(inc.items.length)} of ${String(inc.total)}.`)}</p>`;
    }
  }
  const src = inc.sources
    .map((s) => {
      const name = SOURCE_LABEL[s.source];
      if (!s.indexed) return `${esc(name)}: not indexed`;
      const synced = s.lastSyncMs === null ? "last sync unknown" : `synced ${utc(s.lastSyncMs)}`;
      return `${esc(name)}: ${esc(synced)}${s.stale ? " (may be out of date)" : ""}`;
    })
    .join("; ");
  return `<section><h2>Current incidents</h2>${body}<p class="note">${src}</p></section>`;
}

function shiftLine(s: PageShift): string {
  const where = s.schedule ?? s.policy ?? "On-call";
  const who = s.name ?? "on call";
  const until = s.endMs === null ? "" : ` until ${utc(s.endMs)}`;
  return `<li><span class="where">${esc(where)}</span>: ${esc(who)}${esc(until)}</li>`;
}

function onCallSection(m: StatuspagePageModel): string {
  const oc = m.onCall;
  let body: string;
  if (oc.status === "no_data") {
    body =
      '<p class="unknown"><strong>Unknown:</strong> no on-call shifts are indexed, so this page cannot say ' +
      "who is on call.</p>";
  } else if (oc.status === "no_match") {
    body =
      '<p class="unknown"><strong>Unknown:</strong> no on-call schedule matches the selected services.</p>';
  } else if (oc.status === "none_on_call") {
    body =
      '<p class="unknown"><strong>No on-call shift covers the time of generation.</strong></p>';
  } else {
    body = `<ul>${oc.shifts.map(shiftLine).join("")}</ul>`;
  }
  if (oc.next.length > 0) {
    body += `<h3>Next</h3><ul>${oc.next.map(shiftLine).join("")}</ul>`;
  }
  return `<section><h2>On call now</h2>${body}</section>`;
}

function doraSection(m: StatuspagePageModel): string {
  const d = m.dora;
  let body: string;
  if (d.status === "config_error") {
    body =
      '<p class="unknown"><strong>Unknown:</strong> the service configuration could not be read.</p>';
  } else if (d.status === "no_services") {
    body =
      '<p class="unknown"><strong>Unknown:</strong> no services are configured, so there is nothing to score.</p>';
  } else {
    const rows = d.rows
      .map(
        (r) =>
          `<tr><th scope="row">${esc(r.service)}</th>${doraCell(r.deployment_frequency)}${doraCell(r.lead_time_for_changes)}${doraCell(r.change_failure_rate)}${doraCell(r.mttr)}</tr>`,
      )
      .join("");
    body =
      `<table><thead><tr><th>Service</th><th>Deployment frequency</th><th>Lead time for changes</th>` +
      `<th>Change failure rate</th><th>Time to restore</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="note">${esc(`Computed over the last ${String(d.windowDays)} days.`)}</p>`;
  }
  return `<section><h2>Delivery scorecard (DORA)</h2>${body}</section>`;
}

function footer(m: StatuspagePageModel): string {
  const gaps =
    m.gaps.length === 0
      ? "<p>No gaps were found in the indexed data.</p>"
      : `<ul>${m.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`;
  const scope =
    m.options.services.length === 0
      ? "all configured services"
      : `services: ${m.options.services.join(", ")}`;
  return (
    `<footer><p>Generated ${timeTag(m.generatedAtMs)} by Nimbus from the owner's local index ` +
    `(PagerDuty incidents, Jira Service Management alerts, on-call shifts, CI runs, pull requests; ${esc(scope)}). ` +
    `Nothing was fetched while generating this page, so each figure is only as fresh as the last sync named above.</p>` +
    `<h2>Gaps</h2>${gaps}</footer>`
  );
}

const CSS = `
:root{--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--warn-bg:#fff8c5;--warn-fg:#4d2d00;--ok:#1a7f37;--unk:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--warn-bg:#3d2e00;--warn-fg:#f2cc60;--ok:#3fb950;--unk:#d29922}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:0 16px}
main{max-width:60rem;margin:0 auto;padding:16px 0 48px}
h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem}h3{font-size:1rem}
.draft-banner{background:var(--warn-bg);color:var(--warn-fg);border:1px solid var(--line);padding:8px 12px;border-radius:6px;margin:16px 0}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.note,.nodata{color:var(--muted)}.note{font-size:.875rem}.title{color:var(--muted);font-size:.875rem}
.ok strong{color:var(--ok)}.unknown strong{color:var(--unk)}
footer{margin-top:2rem;border-top:1px solid var(--line);color:var(--muted);font-size:.875rem}
`;

export interface RenderOptions {
  /** The page heading and `<title>`; escaped. */
  title?: string;
}

export function renderStatuspageHtml(m: StatuspagePageModel, opts: RenderOptions = {}): string {
  const rawTitle = opts.title?.trim();
  const title = esc(rawTitle === undefined || rawTitle === "" ? DEFAULT_PAGE_TITLE : rawTitle);
  const date = m.generatedAt.slice(0, 10);
  const banner = `Draft generated by Nimbus on ${date}. Review before publishing.`;
  return (
    `<!doctype html>\n<!-- ${esc(banner)} Delete the draft banner element below when you publish. -->\n` +
    `<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    `<title>${title}</title><style>${CSS}</style></head><body><main>` +
    `<div class="draft-banner" role="note"><strong>${esc(banner)}</strong></div>` +
    `<h1>${title}</h1>` +
    `${incidentsSection(m)}${onCallSection(m)}${doraSection(m)}${footer(m)}` +
    `</main></body></html>\n`
  );
}
