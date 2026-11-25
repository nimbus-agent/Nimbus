import { stripTerminalText } from "../lib/strip-terminal-text.ts";
import { DEBT_USAGE_LINE, type DebtArgs, parseDebtArgs } from "./incident-debt-format.ts";
import {
  FINDINGS_USAGE_LINE,
  type FindingsArgs,
  parseFindingsArgs,
} from "./incident-findings-format.ts";
import {
  parseRemediationArgs,
  REMEDIATE_USAGE,
  type RemediationArgs,
} from "./incident-remediate.ts";
import { RUNBOOK_USAGE_LINE } from "./incident-runbook.ts";

/**
 * Pure helpers for `nimbus incident` (Phase 10 IC3). The CLI cannot import the gateway's types (IPC-only rule),
 * so the shapes below are local structural stand-ins. Text that came from the index (a title) is passed through
 * `stripControlChars` before it reaches the terminal (an ANSI escape in an indexed title must not).
 */

export const INCIDENT_USAGE =
  "Usage: nimbus incident list [--open] [--service <id>] [--source <service>] [--limit <n>] [--cascade] [--json]\n" +
  "       nimbus incident show <id> [--json]\n" +
  "       nimbus incident timeline <id> [--version <n>] [--json]\n" +
  "       nimbus incident investigate <id> [--live [--live-budget <seconds>]] [--synthesize] [--json]\n" +
  `${REMEDIATE_USAGE}
` +
  `${DEBT_USAGE_LINE}\n` +
  `${FINDINGS_USAGE_LINE}\n` +
  "       nimbus incident postmortem <id> [--out <file>] [--template <file>] [--synthesize] | --push notion|confluence ...\n" +
  "       nimbus incident update <id> [--audience stakeholders|engineers] [--out <file>] | --send slack:<c>|teams:<t>/<c> | --queued\n" +
  `${RUNBOOK_USAGE_LINE}\n` +
  "  <id> is a record id (inc_...), a trigger item id (pagerduty:...), or the provider's own id.";

export const SOURCES = ["pagerduty", "jira", "sentry", "montecarlo", "bigeye"] as const;

export type IncidentArgs =
  | {
      readonly verb: "list";
      readonly json: boolean;
      readonly open: boolean;
      readonly service?: string;
      readonly source?: string;
      readonly limit?: number;
      readonly cascade: boolean;
    }
  | { readonly verb: "show"; readonly json: boolean; readonly id: string }
  | {
      readonly verb: "investigate";
      readonly json: boolean;
      readonly id: string;
      readonly synthesize?: boolean;
      /** Owner ruling 9: read the bound backend (Sentry) now, through the gateway's gate, in addition to the index. */
      readonly live?: boolean;
      readonly liveBudget?: number;
    }
  | {
      readonly verb: "timeline";
      readonly json: boolean;
      readonly id: string;
      readonly version?: number;
    }
  | RemediationArgs
  | DebtArgs
  | FindingsArgs;

type ListFlags = {
  open: boolean;
  cascade: boolean;
  service?: string;
  source?: string;
  limit?: number;
};

function takeValue(argv: readonly string[], i: number): string | undefined {
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

const LIST_SWITCHES: ReadonlySet<string> = new Set(["--json", "--open", "--cascade"]);
const LIST_VALUE_FLAGS: ReadonlySet<string> = new Set(["--service", "--source", "--limit"]);

/** Takes one `list` value flag into `flags`; false for a repeat or a value the flag refuses. */
function takeListValue(flags: ListFlags, a: string, v: string): boolean {
  if (a === "--service") {
    if (flags.service !== undefined) return false;
    flags.service = v;
    return true;
  }
  if (a === "--source") {
    if (flags.source !== undefined || !SOURCES.includes(v as never)) return false;
    flags.source = v;
    return true;
  }
  const n = Number(v);
  if (flags.limit !== undefined || !Number.isInteger(n) || n < 1 || n > 200) return false;
  flags.limit = n;
  return true;
}

function parseListFlags(argv: readonly string[]): { json: boolean; flags: ListFlags } | undefined {
  const flags: ListFlags = { open: false, cascade: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (LIST_SWITCHES.has(a)) {
      if (seen.has(a)) return undefined;
      seen.add(a);
    } else if (LIST_VALUE_FLAGS.has(a)) {
      const v = takeValue(argv, i);
      if (v === undefined || !takeListValue(flags, a, v)) return undefined;
      i += 1;
    } else {
      return undefined;
    }
  }
  flags.open = seen.has("--open");
  flags.cascade = seen.has("--cascade");
  return { json: seen.has("--json"), flags };
}

function parseListArgs(rest: readonly string[]): IncidentArgs | undefined {
  const parsed = parseListFlags(rest);
  if (parsed === undefined) return undefined;
  const { flags } = parsed;
  return {
    verb: "list",
    json: parsed.json,
    open: flags.open,
    cascade: flags.cascade,
    ...(flags.service === undefined ? {} : { service: flags.service }),
    ...(flags.source === undefined ? {} : { source: flags.source }),
    ...(flags.limit === undefined ? {} : { limit: flags.limit }),
  };
}

function parseShowArgs(rest: readonly string[]): IncidentArgs | undefined {
  const json = rest.filter((a) => a === "--json");
  const ids = rest.filter((a) => a !== "--json");
  const [id] = ids;
  if (json.length > 1) return undefined;
  if (ids.length !== 1 || id === undefined || id.startsWith("--")) return undefined;
  return { verb: "show", json: json.length === 1, id };
}

const VERB_PARSERS: Readonly<
  Record<string, (rest: readonly string[]) => IncidentArgs | undefined>
> = {
  list: parseListArgs,
  show: parseShowArgs,
  investigate: (rest) => parseInvestigateArgs(rest),
  timeline: (rest) => parseTimelineArgs(rest),
  debt: parseDebtArgs,
  findings: parseFindingsArgs,
};

export function parseIncidentArgs(argv: readonly string[]): IncidentArgs | undefined {
  const [verb, ...rest] = argv;
  const parse =
    verb !== undefined && Object.hasOwn(VERB_PARSERS, verb) ? VERB_PARSERS[verb] : undefined;
  return parse === undefined ? parseRemediationArgs(verb, rest) : parse(rest);
}

const INVESTIGATE_SWITCHES: ReadonlySet<string> = new Set(["--json", "--synthesize", "--live"]);

/** `--live-budget <seconds>`: 1 to 60, at most two digits. */
function parseLiveBudget(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d{1,2}$/.test(v)) return undefined;
  const n = Number(v);
  return n < 1 || n > 60 ? undefined : n;
}

interface InvestigateState {
  readonly seen: Set<string>;
  liveBudget: number | undefined;
  id: string | undefined;
}

/** Consumes one token; returns the index of the last token used, or undefined when it is refused. */
function takeInvestigateToken(
  st: InvestigateState,
  rest: readonly string[],
  i: number,
): number | undefined {
  const a = rest[i] as string;
  if (INVESTIGATE_SWITCHES.has(a)) {
    if (st.seen.has(a)) return undefined;
    st.seen.add(a);
    return i;
  }
  if (a === "--live-budget") {
    if (st.liveBudget !== undefined) return undefined;
    st.liveBudget = parseLiveBudget(takeValue(rest, i));
    return st.liveBudget === undefined ? undefined : i + 1;
  }
  if (a.startsWith("--") || st.id !== undefined) return undefined;
  st.id = a;
  return i;
}

/** `investigate <id> [--live [--live-budget <seconds>]] [--synthesize] [--json]`; each flag at most once. */
function parseInvestigateArgs(rest: readonly string[]): IncidentArgs | undefined {
  const st: InvestigateState = { seen: new Set<string>(), liveBudget: undefined, id: undefined };
  for (let i = 0; i < rest.length; i += 1) {
    const last = takeInvestigateToken(st, rest, i);
    if (last === undefined) return undefined;
    i = last;
  }
  const { seen, liveBudget, id } = st;
  const live = seen.has("--live");
  if (id === undefined || (liveBudget !== undefined && !live)) return undefined;
  return {
    verb: "investigate",
    json: seen.has("--json"),
    id,
    ...(seen.has("--synthesize") ? { synthesize: true } : {}),
    ...(live ? { live: true } : {}),
    ...(liveBudget === undefined ? {} : { liveBudget }),
  };
}

/** `--version <n>`: 1 to 1,000,000, at most seven digits. */
function parseVersionValue(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d{1,7}$/.test(v)) return undefined;
  const n = Number(v);
  return n < 1 || n > 1_000_000 ? undefined : n;
}

interface TimelineState {
  json: boolean;
  version: number | undefined;
  id: string | undefined;
}

/** Consumes one token; returns the index of the last token used, or undefined when it is refused. */
function takeTimelineToken(
  st: TimelineState,
  rest: readonly string[],
  i: number,
): number | undefined {
  const a = rest[i] as string;
  if (a === "--json") {
    if (st.json) return undefined;
    st.json = true;
    return i;
  }
  if (a === "--version") {
    if (st.version !== undefined) return undefined;
    st.version = parseVersionValue(takeValue(rest, i));
    return st.version === undefined ? undefined : i + 1;
  }
  if (a.startsWith("--") || st.id !== undefined) return undefined;
  st.id = a;
  return i;
}

function parseTimelineArgs(rest: readonly string[]): IncidentArgs | undefined {
  const st: TimelineState = { json: false, version: undefined, id: undefined };
  for (let i = 0; i < rest.length; i += 1) {
    const last = takeTimelineToken(st, rest, i);
    if (last === undefined) return undefined;
    i = last;
  }
  const { json, version, id } = st;
  if (id === undefined) return undefined;
  return { verb: "timeline", json, id, ...(version === undefined ? {} : { version }) };
}

export interface SummaryLike {
  readonly id: string;
  readonly triggerItemId: string;
  readonly triggerService: string;
  readonly service: string | null;
  readonly title: string;
  readonly severity: string | null;
  readonly status: string;
  readonly openedAtMs: number | null;
  readonly version: number;
  readonly assembledAtMs: number;
  readonly checkedAtMs: number;
}

export interface SourceLike {
  readonly service: string;
  readonly connected: boolean;
  readonly lastSyncMs: number | null;
}

export function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ago(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h`;
  return `${String(Math.floor(s / 86_400))}d`;
}

const clean = (s: string): string => stripTerminalText(s).replace(/\s+/g, " ").trim();

export function listLine(r: SummaryLike): string {
  const opened = r.openedAtMs === null ? "no open time    " : utc(r.openedAtMs);
  return [
    r.id,
    opened,
    r.status.padEnd(7),
    (r.severity === null ? "-" : clean(r.severity)).padEnd(6),
    clean(r.triggerService).padEnd(10),
    r.service === null ? "(unbound)" : clean(r.service),
    `v${String(r.version)}`,
    clean(r.title),
  ].join("  ");
}

export function sourcesLine(sources: readonly SourceLike[]): string {
  const on = sources.filter((s) => s.connected).map((s) => s.service);
  const off = sources.filter((s) => !s.connected).map((s) => s.service);
  return `Connected: ${on.length === 0 ? "none" : on.join(", ")}. Not connected: ${off.length === 0 ? "none" : off.join(", ")}.`;
}

/** `YYYY-MM-DD HH:MM:SS UTC`: a timeline keeps seconds, so events a minute apart keep their order. */
export function utcSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export interface TimelineEventLike {
  readonly atMs: number;
  readonly atBasis: string;
  readonly kind: string;
  readonly text: string;
}

export interface TimelineReplyLike {
  readonly recordId: string;
  readonly version: number;
  readonly currentVersion: number;
  readonly events: readonly TimelineEventLike[];
  readonly notes: readonly string[];
}

/** The timeline as terminal text: every provider-influenced field passes through `stripControlChars`. */
export function formatTimeline(t: TimelineReplyLike): string {
  const older = t.version === t.currentVersion ? "" : " (an older version: what was known then)";
  const head = `Timeline of ${clean(t.recordId)}, version ${String(t.version)} of ${String(t.currentVersion)}${older}`;
  const lines =
    t.events.length === 0
      ? ["No event to show."]
      : t.events.map(
          (e) => `${utcSeconds(e.atMs)} (${clean(e.atBasis)}) ${clean(e.kind)}: ${clean(e.text)}`,
        );
  return [head, ...lines, ...t.notes.map((n) => `Note: ${clean(n)}`)].join("\n");
}

export interface CascadeGroupLike {
  readonly relationLabel: string;
  readonly reachCapped: boolean;
  readonly members: readonly {
    readonly recordId: string;
    readonly role: string;
    readonly title?: string;
    readonly service?: string | null;
  }[];
}

/** `incident list --cascade`: each open group, the root first. */
export function formatCascadeGroups(groups: readonly CascadeGroupLike[] | null): string[] {
  if (groups === null) return ["The open records could not be ranked this time."];
  if (groups.length === 0) return ["No cascade: no two open records opened within 30 minutes."];
  const out: string[] = [];
  groups.forEach((g, i) => {
    const capped = g.reachCapped ? " (dependency graph too large to search completely)" : "";
    out.push(`Cascade ${String(i + 1)}: ${clean(g.relationLabel)}${capped}`);
    for (const m of g.members) {
      const role = m.role === "root" ? "root candidate" : "downstream    ";
      const svc = m.service === null || m.service === undefined ? "(unbound)" : clean(m.service);
      out.push(`  ${role}  ${clean(m.recordId)}  ${svc}  ${clean(m.title ?? "")}`.trimEnd());
    }
  });
  return out;
}

/** `Record <id> v<N>, assembled <UTC> (<age> ago), last checked <UTC>`. */
export function recordFooter(s: SummaryLike, nowMs: number): string {
  return `Record ${s.id} v${String(s.version)}, assembled ${utc(s.assembledAtMs)} (${ago(s.assembledAtMs, nowMs)} ago), last checked ${utc(s.checkedAtMs)}`;
}
