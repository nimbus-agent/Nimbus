import { stripControlChars } from "../lib/strip-control-chars.ts";

/**
 * Pure helpers for `nimbus incident` (Phase 10 IC3). The CLI cannot import the gateway's types (IPC-only rule),
 * so the shapes below are local structural stand-ins. Text that came from the index (a title) is passed through
 * `stripControlChars` before it reaches the terminal (an ANSI escape in an indexed title must not).
 */

export const INCIDENT_USAGE =
  "Usage: nimbus incident list [--open] [--service <id>] [--source <service>] [--limit <n>] [--json]\n" +
  "       nimbus incident show <id> [--json]\n" +
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
    }
  | { readonly verb: "show"; readonly json: boolean; readonly id: string };

type ListFlags = { open: boolean; service?: string; source?: string; limit?: number };

function takeValue(argv: readonly string[], i: number): string | undefined {
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

function parseListFlags(argv: readonly string[]): { json: boolean; flags: ListFlags } | undefined {
  const flags: ListFlags = { open: false };
  let json = false;
  let seenJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      if (seenJson) return undefined;
      seenJson = true;
      json = true;
    } else if (a === "--open") {
      if (flags.open) return undefined;
      flags.open = true;
    } else if (a === "--service" || a === "--source" || a === "--limit") {
      const v = takeValue(argv, i);
      const dup = a === "--service" ? flags.service : a === "--source" ? flags.source : flags.limit;
      if (v === undefined || dup !== undefined) return undefined;
      i += 1;
      if (a === "--service") flags.service = v;
      else if (a === "--source") {
        if (!SOURCES.includes(v as never)) return undefined;
        flags.source = v;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 200) return undefined;
        flags.limit = n;
      }
    } else {
      return undefined;
    }
  }
  return { json, flags };
}

export function parseIncidentArgs(argv: readonly string[]): IncidentArgs | undefined {
  const [verb, ...rest] = argv;
  if (verb === "list") {
    const parsed = parseListFlags(rest);
    if (parsed === undefined) return undefined;
    const { flags } = parsed;
    return {
      verb: "list",
      json: parsed.json,
      open: flags.open,
      ...(flags.service === undefined ? {} : { service: flags.service }),
      ...(flags.source === undefined ? {} : { source: flags.source }),
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    };
  }
  if (verb === "show") {
    const json = rest.filter((a) => a === "--json");
    const ids = rest.filter((a) => a !== "--json");
    const [id] = ids;
    if (json.length > 1 || ids.length !== 1 || id === undefined || id.startsWith("--")) {
      return undefined;
    }
    return { verb: "show", json: json.length === 1, id };
  }
  return undefined;
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

const clean = (s: string): string => stripControlChars(s).replace(/\s+/g, " ").trim();

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

/** `Record <id> v<N>, assembled <UTC> (<age> ago), last checked <UTC>`. */
export function recordFooter(s: SummaryLike, nowMs: number): string {
  return `Record ${s.id} v${String(s.version)}, assembled ${utc(s.assembledAtMs)} (${ago(s.assembledAtMs, nowMs)} ago), last checked ${utc(s.checkedAtMs)}`;
}
