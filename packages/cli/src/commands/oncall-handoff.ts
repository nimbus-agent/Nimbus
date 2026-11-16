import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
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
type Result = {
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
const clean = (s: string): string => stripControlChars(s);

/** A bare duration means "that long ago"; the gateway's time parser takes it as `-<duration>`. */
export function toTimeParam(raw: string): string {
  const t = raw.trim();
  const m = DURATION.exec(t);
  return m === null ? t : `-${m[1] as string}${(m[2] as string).toLowerCase()}`;
}

export function parseOncallHandoffArgs(argv: readonly string[]): OncallHandoffArgs | undefined {
  let json = false;
  const v: { since?: string; until?: string; service?: string } = {};
  const flags = ["--since", "--until", "--service"] as const;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      json = true;
      continue;
    }
    const flag = flags.find((f) => a === f || a.startsWith(`${f}=`));
    if (flag === undefined) return undefined;
    const key = flag.slice(2) as "since" | "until" | "service";
    if (v[key] !== undefined) return undefined;
    let value: string | undefined;
    if (a === flag) {
      i += 1;
      value = argv[i];
    } else {
      value = a.slice(flag.length + 1);
    }
    if (
      value === undefined ||
      value.trim() === "" ||
      (value.startsWith("-") && key === "service")
    ) {
      return undefined;
    }
    v[key] = key === "service" ? value : toTimeParam(value);
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

function eventLine(e: Event): string {
  const basis = e.atBasis === "observed" ? " (observed)" : "";
  const what =
    e.kind === "state_changed" || e.kind === "resolved"
      ? `${e.kind === "resolved" ? "resolved" : "changed"}${e.key === null ? "" : ` ${clean(e.key)}`}${
          e.from === null && e.to === null
            ? ""
            : `: ${clean(e.from ?? "none")} -> ${clean(e.to ?? "none")}`
        }`
      : e.kind;
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
    out += `- ${label(o.source)} ${clean(o.title)} [${clean(o.itemId)}] ${age}${extra.length === 0 ? "" : ` (${extra.join(", ")})`}\n`;
  }
  out += more(r.stillOpen);
  return out;
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

function renderTail(r: Result): string {
  let out = "## Gaps\n";
  for (const g of r.gaps) out += `- ${clean(g.detail)}\n`;
  out += "## Data freshness\n";
  for (const f of r.freshness) {
    out += `- ${label(f.source)} last synced: ${f.lastSyncMs === null ? "never recorded" : `${utc(f.lastSyncMs)} (${String(Math.max(0, Math.round((r.asOfMs - f.lastSyncMs) / 60_000)))} min ago)`}\n`;
  }
  for (const s of r.shift.sources) {
    const age =
      s.oldestFetchedMs === null
        ? "age unknown"
        : `${String(Math.max(0, Math.round((r.asOfMs - s.oldestFetchedMs) / 60_000)))} min old`;
    out += `- ${label(s.source)} shifts: ${age}${s.stale ? " (older than 1 h; the shift may have changed)" : ""}\n`;
  }
  out +=
    r.historyStartsMs === null
      ? "- State-change history: none recorded yet\n"
      : `- State-change history begins ${utc(r.historyStartsMs)}\n`;
  return out;
}

export function renderHandoff(r: Result): string {
  const head = `# On-call handoff${r.service === null ? "" : ` for ${clean(r.service)}`}\n`;
  return [
    head + renderShift(r),
    renderEvents(r),
    renderOpen(r),
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
