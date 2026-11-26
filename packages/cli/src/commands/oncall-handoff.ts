import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { stripTerminalText } from "../lib/strip-terminal-text.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

export interface OncallHandoffArgs {
  readonly since?: string;
  readonly until?: string;
  readonly service?: string;
  readonly json: boolean;
}
export interface OncallHandoffIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface OncallHandoffSink {
  out(s: string): void;
  err(s: string): void;
}

export const ONCALL_HANDOFF_USAGE =
  "Usage: nimbus oncall handoff [--since <duration|time>] [--until <duration|time>] [--service <id|name>] [--json]";

export const ONCALL_HANDOFF_HELP =
  `${ONCALL_HANDOFF_USAGE}\n` +
  "  --since    window start: a duration back from now (12h, 2d) or a time (2026-11-16T08:00Z,\n" +
  "             2026-11-16T08:00 in the gateway zone, yesterday-18:00). Default: the start of your\n" +
  "             current on-call shift when the index holds one, else the last 12 hours\n" +
  "  --until    window end, same forms (default: now)\n" +
  "  --service  limit to one configured service (a [ci.service.*] id)\n" +
  "  --json     print the structured result\n" +
  "Reads the local index only: no live call, no approval prompt, nothing is written.";

type Shift = {
  source: string;
  userName: string;
  scheduleName: string | null;
  policyName: string | null;
  level: number | null;
  startMs: number | null;
  endMs: number | null;
  isMe: boolean;
};
type Counted<T> = { items: T[]; total: number };
type Event = {
  kind: string;
  source: string;
  itemId: string;
  title: string;
  url: string | null;
  atMs: number;
  atBasis: "provider" | "observed";
  key: string | null;
  from: string | null;
  to: string | null;
};
type OpenItem = {
  source: string;
  itemId: string;
  title: string;
  status: string | null;
  severity: string | null;
  openedAtMs: number | null;
  acknowledged: boolean | null;
};
type Deployment = {
  id: string;
  title: string;
  serviceId: string;
  environment: string;
  conclusion: string;
  startedAtMs: number;
};
type Watch = { reason: string; source: string; itemId: string; title: string; detail: string };
type Correlation = {
  deployment: Deployment;
  items: Array<{
    source: string;
    itemId: string;
    title: string;
    openedAtMs: number;
    stillOpen: boolean;
  }>;
};
type Due = { service: string; itemId: string; title: string; dueMs: number; overdue: boolean };
type RecordRef = {
  recordId: string;
  triggerItemId: string;
  triggerService: string;
  service: string | null;
  title: string;
  severity: string | null;
  status: string;
  openedAtMs: number | null;
  closedAtMs: number | null;
  reason?: string;
};
/** The IC9a incident-record sections; absent from an older gateway and for a non-owner connection. */
type Records = {
  status: "ok" | "no_records";
  opened: Counted<RecordRef>;
  resolved: Counted<RecordRef>;
  stillOpen: Counted<RecordRef>;
  smouldering: Counted<RecordRef>;
  freshness: Array<{ service: string; connected: boolean; lastSyncMs: number | null }>;
  gaps: Array<{ code: string; detail: string }>;
};
type Result = {
  records?: Records;
  status: "ok" | "no_match";
  asOfMs: number;
  window: { fromMs: number; toMs: number; basis: string; reason: string };
  service: string | null;
  known: string[];
  shift: {
    status: string;
    mine: Shift[];
    onCallNow: Shift[];
    next: Shift[];
    sources: Array<{ source: string; oldestFetchedMs: number | null; stale: boolean }>;
  };
  events: Counted<Event>;
  deployments: Counted<Deployment>;
  stillOpen: Counted<OpenItem>;
  watch: {
    flagged: Counted<Watch>;
    deploysWithIncidents: Counted<Correlation>;
    due: Counted<Due>;
  };
  freshness: Array<{ source: string; lastSyncMs: number | null }>;
  historyStartsMs: number | null;
  gaps: Array<{ code: string; detail: string }>;
};

const DURATION = /^(\d{1,9})\s*([smhdw])$/i;
const clean = (s: string): string => stripTerminalText(s);

/** A bare duration means "that long ago"; the gateway's time parser takes it as `-<duration>`. */
export function toTimeParam(raw: string): string {
  const t = raw.trim();
  const m = DURATION.exec(t);
  return m === null ? t : `-${m[1] as string}${(m[2] as string).toLowerCase()}`;
}

/** A flag's value as sent: a service as given (never a flag), a time through `toTimeParam`. */
function handoffValue(
  key: "since" | "until" | "service",
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (key !== "service") return toTimeParam(value);
  return value.startsWith("-") ? undefined : value;
}

type HandoffKey = "since" | "until" | "service";
type HandoffValues = { since?: string; until?: string; service?: string };
const HANDOFF_FLAGS = ["--since", "--until", "--service"] as const;

/** Reads one `--flag value` or `--flag=value` into `v`; returns the last index used, or undefined if refused. */
function takeHandoffFlag(v: HandoffValues, argv: readonly string[], i: number): number | undefined {
  const a = argv[i] as string;
  const flag = HANDOFF_FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
  if (flag === undefined) return undefined;
  const key = flag.slice(2) as HandoffKey;
  if (v[key] !== undefined) return undefined;
  const last = a === flag ? i + 1 : i;
  const value = handoffValue(key, a === flag ? argv[last] : a.slice(flag.length + 1));
  if (value === undefined) return undefined;
  v[key] = value;
  return last;
}

export function parseOncallHandoffArgs(argv: readonly string[]): OncallHandoffArgs | undefined {
  let json = false;
  const v: HandoffValues = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") {
      json = true;
      continue;
    }
    const last = takeHandoffFlag(v, argv, i);
    if (last === undefined) return undefined;
    i = last;
  }
  return {
    json,
    ...(v.since === undefined ? {} : { since: v.since }),
    ...(v.until === undefined ? {} : { until: v.until }),
    ...(v.service === undefined ? {} : { service: v.service }),
  };
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const SOURCE_LABEL: Record<string, string> = {
  pagerduty: "PagerDuty",
  jsm: "Jira Service Management",
  jira: "Jira",
  sentry: "Sentry",
  montecarlo: "Monte Carlo",
  bigeye: "Bigeye",
};
const label = (s: string): string => SOURCE_LABEL[s] ?? clean(s);

function shiftLine(s: Shift): string {
  const where = clean(s.scheduleName ?? s.policyName ?? "unknown schedule");
  const parts: string[] = [];
  if (s.level !== null) parts.push(`level ${String(s.level)}`);
  if (s.startMs !== null) parts.push(`from ${utc(s.startMs)}`);
  if (s.endMs !== null) parts.push(`until ${utc(s.endMs)}`);
  const detail = parts.length === 0 ? "" : ` [${parts.join(", ")}]`;
  return `- ${where}: ${clean(s.userName)}${detail} (${label(s.source)})${s.isMe ? " <- you" : ""}\n`;
}

function more<T>(c: Counted<T>): string {
  return c.total > c.items.length
    ? `- ... and ${String(c.total - c.items.length)} more (total ${String(c.total)})\n`
    : "";
}

/** `resolved status: open -> closed`, `changed status`, or the bare kind for any other event. */
function eventWhat(e: Event): string {
  if (e.kind !== "state_changed" && e.kind !== "resolved") return e.kind;
  const verb = e.kind === "resolved" ? "resolved" : "changed";
  const key = e.key === null ? "" : ` ${clean(e.key)}`;
  const change =
    e.from === null && e.to === null
      ? ""
      : `: ${clean(e.from ?? "none")} -> ${clean(e.to ?? "none")}`;
  return `${verb}${key}${change}`;
}

function eventLine(e: Event): string {
  const basis = e.atBasis === "observed" ? " (observed)" : "";
  const what = eventWhat(e);
  return `- ${utc(e.atMs)}${basis} ${label(e.source)} ${what}: ${clean(e.title)} [${clean(e.itemId)}]\n`;
}

function renderShift(r: Result): string {
  let out = "## Shift\n";
  const w = r.window;
  out += `Window: ${utc(w.fromMs)} to ${utc(w.toMs)}. ${clean(w.reason)}\n`;
  if (r.shift.status === "no_data") {
    out += "No on-call shifts are indexed; see Gaps.\n";
    return out;
  }
  if (r.shift.mine.length > 0) {
    out += "Your shift:\n";
    for (const s of r.shift.mine) out += shiftLine(s);
  }
  if (r.shift.onCallNow.length > 0) {
    out += "On call now:\n";
    for (const s of r.shift.onCallNow) out += shiftLine(s);
  } else if (r.shift.status === "none_on_call") {
    out += "No indexed shift covers now.\n";
  }
  if (r.shift.next.length > 0) {
    out += "Next on call:\n";
    for (const s of r.shift.next) out += shiftLine(s);
  }
  return out;
}

function renderEvents(r: Result): string {
  let out = "## Events during the shift\n";
  if (r.events.items.length === 0)
    out += "No incident or alert events are recorded in this window.\n";
  for (const e of r.events.items) out += eventLine(e);
  out += more(r.events);
  out += "Deployments:\n";
  if (r.deployments.items.length === 0) out += "- none recorded in this window\n";
  for (const d of r.deployments.items) {
    out += `- ${utc(d.startedAtMs)} ${clean(d.serviceId)} -> ${clean(d.environment)} (${clean(d.conclusion)}): ${clean(d.title)}\n`;
  }
  out += more(r.deployments);
  return out;
}

function renderOpen(r: Result): string {
  let out = "## Still open\n";
  if (r.stillOpen.items.length === 0) {
    out += "No open incident or alert is recorded at the end of the window.\n";
  }
  for (const o of r.stillOpen.items) {
    const age = o.openedAtMs === null ? "opened time unknown" : `opened ${utc(o.openedAtMs)}`;
    const extra = [o.status, o.severity].filter((x): x is string => x !== null).map(clean);
    if (o.acknowledged === true) extra.push("acknowledged");
    const extraText = extra.length === 0 ? "" : ` (${extra.join(", ")})`;
    out += `- ${label(o.source)} ${clean(o.title)} [${clean(o.itemId)}] ${age}${extraText}\n`;
  }
  out += more(r.stillOpen);
  return out;
}

const SMOULDERING_REASON: Record<string, string> = {
  open_over_4h: "open over 4 hours",
  retriggered: "re-triggered",
};

function recordLine(x: RecordRef, extra?: string): string {
  const parts = [x.severity, x.status].filter((v): v is string => v !== null).map(clean);
  if (extra !== undefined) parts.push(extra);
  const when = x.openedAtMs === null ? "opened time unknown" : `opened ${utc(x.openedAtMs)}`;
  const svc = x.service === null ? "" : ` ${clean(x.service)}`;
  return `- ${label(x.triggerService)}${svc}: ${clean(x.title)} [${clean(x.recordId)}] ${when} (${parts.join(", ")})\n`;
}

function renderRecordList(heading: string, c: Counted<RecordRef>): string {
  let out = `${heading}\n`;
  if (c.items.length === 0) out += "- none\n";
  for (const x of c.items) {
    const reason =
      x.reason === undefined ? undefined : (SMOULDERING_REASON[x.reason] ?? clean(x.reason));
    out += recordLine(x, reason);
  }
  out += more(c);
  return out;
}

function renderRecords(r: Result): string {
  const rec = r.records;
  if (rec === undefined) return "";
  const head = "## Incident records\n";
  if (rec.status === "no_records") {
    return `${head}No incident record has been assembled yet; see Gaps.\n`;
  }
  return (
    head +
    renderRecordList("Opened in the window:", rec.opened) +
    renderRecordList("Resolved in the window:", rec.resolved) +
    renderRecordList("Still open at the end of the window:", rec.stillOpen) +
    renderRecordList("Smouldering (open over 4 hours, or re-triggered):", rec.smouldering)
  );
}

function renderWatch(r: Result): string {
  let out = "## Watch-list\n";
  const w = r.watch;
  if (w.flagged.items.length === 0) out += "No reopened or repeatedly changing item is recorded.\n";
  for (const f of w.flagged.items) {
    out += `- ${f.reason === "reopened" ? "Reopened" : "Changed state repeatedly"}: ${clean(f.title)} [${clean(f.itemId)}] ${clean(f.detail)}\n`;
  }
  out += more(w.flagged);
  out += "Deployments followed by an incident or alert of the same service:\n";
  if (w.deploysWithIncidents.items.length === 0) out += "- none found\n";
  for (const c of w.deploysWithIncidents.items) {
    out += `- ${utc(c.deployment.startedAtMs)} ${clean(c.deployment.serviceId)}: ${clean(c.deployment.title)}\n`;
    for (const i of c.items) {
      out += `    ${label(i.source)} opened ${utc(i.openedAtMs)} (${i.stillOpen ? "still open" : "closed"}): ${clean(i.title)}\n`;
    }
  }
  out += more(w.deploysWithIncidents);
  out += "Due within 24 hours of the window end, from your assigned work:\n";
  if (w.due.items.length === 0) out += "- none recorded\n";
  for (const d of w.due.items) {
    out += `- ${d.overdue ? "OVERDUE" : "due"} ${utc(d.dueMs)} ${clean(d.service)}: ${clean(d.title)} [${clean(d.itemId)}]\n`;
  }
  out += more(w.due);
  return out;
}

function minutesAgo(r: Result, ms: number): string {
  return String(Math.max(0, Math.round((r.asOfMs - ms) / 60_000)));
}

function syncedText(r: Result, lastSyncMs: number | null): string {
  if (lastSyncMs === null) return "never recorded";
  return `${utc(lastSyncMs)} (${minutesAgo(r, lastSyncMs)} min ago)`;
}

function shiftAgeLine(r: Result, s: Result["shift"]["sources"][number]): string {
  const age =
    s.oldestFetchedMs === null ? "age unknown" : `${minutesAgo(r, s.oldestFetchedMs)} min old`;
  const stale = s.stale ? " (older than 1 h; the shift may have changed)" : "";
  return `- ${label(s.source)} shifts: ${age}${stale}`;
}

/** The record sources other than PagerDuty and Jira (whose freshness is listed above). */
function recordFreshnessLines(r: Result): string[] {
  const lines: string[] = [];
  for (const f of r.records?.freshness ?? []) {
    if (f.service === "pagerduty" || f.service === "jira") continue;
    let when = "not connected";
    if (f.connected) when = f.lastSyncMs === null ? "never recorded" : utc(f.lastSyncMs);
    lines.push(`- ${label(f.service)} last synced: ${when}`);
  }
  return lines;
}

function renderTail(r: Result): string {
  const lines = [
    "## Gaps",
    ...r.gaps.map((g) => `- ${clean(g.detail)}`),
    ...(r.records?.gaps ?? []).map((g) => `- ${clean(g.detail)}`),
    "## Data freshness",
    ...r.freshness.map((f) => `- ${label(f.source)} last synced: ${syncedText(r, f.lastSyncMs)}`),
    ...r.shift.sources.map((s) => shiftAgeLine(r, s)),
    ...recordFreshnessLines(r),
    r.historyStartsMs === null
      ? "- State-change history: none recorded yet"
      : `- State-change history begins ${utc(r.historyStartsMs)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderHandoff(r: Result): string {
  const forService = r.service === null ? "" : ` for ${clean(r.service)}`;
  const head = `# On-call handoff${forService}\n`;
  return [
    head + renderShift(r),
    renderEvents(r),
    renderOpen(r),
    ...(r.records === undefined ? [] : [renderRecords(r)]),
    renderWatch(r),
    renderTail(r),
  ].join("\n");
}

export async function runOncallHandoffWith(
  c: OncallHandoffIpc,
  a: OncallHandoffArgs,
  sink: OncallHandoffSink,
): Promise<number> {
  try {
    // The incident-record sections are served only to a connection that declared `cli` or `ui` (IC9a).
    await declareCliClientKind({ call: <T>(m: string, p?: unknown) => c.call(m, p) as Promise<T> });
    const params: Record<string, string> = {};
    if (a.since !== undefined) params["since"] = a.since;
    if (a.until !== undefined) params["until"] = a.until;
    if (a.service !== undefined) params["service"] = a.service;
    const r = (await c.call("oncall.handoff", params)) as Result;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return r.status === "ok" ? 0 : 1;
    }
    if (r.status === "no_match") {
      sink.err(`No configured service matches "${clean(r.service ?? "")}".\n`);
      if (r.known.length > 0) sink.err(`Configured services: ${r.known.map(clean).join(", ")}\n`);
      return 1;
    }
    sink.out(renderHandoff(r));
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${clean(msg)}\n`);
    return 1;
  }
}

export async function runOncallHandoff(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${ONCALL_HANDOFF_HELP}\n`);
    return;
  }
  const a = parseOncallHandoffArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${ONCALL_HANDOFF_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runOncallHandoffWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
