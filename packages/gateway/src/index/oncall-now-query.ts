import type { Database } from "bun:sqlite";

import {
  ONCALL_SHIFT_ITEM_TYPE,
  ONCALL_STALE_MS,
  type OncallShiftMeta,
  type OncallSource,
} from "./oncall-shift-types.ts";

/**
 * "Who is on call right now?" answered from the local index only (Phase 10 MB3): pure over the database,
 * reads only, no network, no config file. A row's currentness depends on `now`, so it is classified at READ
 * time, not at refresh time. Refusals are explicit statuses (`no_data`, `no_match`) because an empty list
 * reads as "nobody is on call", the one wrong answer that looks right.
 */
export const ONCALL_NOW_MAX_CURRENT = 50;
export const ONCALL_NOW_MAX_UPCOMING = 50;
export const ONCALL_NOW_HORIZON_MS = 7 * 86_400_000;
export const ONCALL_NOW_MAX_KNOWN = 20;

export type OncallNowStatus = "ok" | "none_on_call" | "no_match" | "no_data";
export type OncallResolvedVia = "binding" | "service_id" | "service_name" | "schedule_or_policy";

/** A `[ci.service.<id>]` binding, reduced to what matching needs. */
export interface OncallServiceBinding {
  serviceId: string;
  pagerdutyServices: readonly string[];
}

export interface OncallShiftView {
  source: OncallSource;
  userName: string;
  userEmail: string | null;
  policyName: string | null;
  scheduleName: string | null;
  level: number | null;
  startMs: number | null;
  endMs: number | null;
  isMe: boolean;
  serviceNames: string[];
  serviceIds: string[];
}

export interface OncallSourceAge {
  source: OncallSource;
  /** The OLDEST `fetched_at_ms` among the rows this source contributed; null when a row carries none. */
  oldestFetchedMs: number | null;
  stale: boolean;
}

export interface OncallNowResult {
  status: OncallNowStatus;
  asOfMs: number;
  query: string | null;
  resolvedVia: OncallResolvedVia | null;
  youAreOnCall: boolean;
  sources: OncallSourceAge[];
  shifts: OncallShiftView[];
  next: OncallShiftView[];
  /** `no_match` only: up to 20 schedule, policy and service names to retry with. */
  known: string[];
  gaps: string[];
}

export interface OncallNowOptions {
  nowMs: number;
  /** A service id or name, a PagerDuty service id, or a schedule or policy name. Absent = everything. */
  term?: string;
  /** Matches ONLY rows whose escalation policy covers this PagerDuty service id (the incident brief). */
  pagerdutyServiceId?: string;
  serviceConfigs?: readonly OncallServiceBinding[];
}

type Row = {
  view: OncallShiftView;
  shift: "current" | "next" | null;
  fetchedMs: number | null;
  mapComplete: boolean;
};

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseRow(metadata: string): Row | null {
  let raw: unknown;
  try {
    raw = JSON.parse(metadata) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Partial<Record<keyof OncallShiftMeta, unknown>>;
  const userName = str(m.user_name);
  const source = m.source === "pagerduty" || m.source === "jsm" ? m.source : null;
  if (userName === null || source === null) return null;
  const shift = m.shift === "current" || m.shift === "next" ? m.shift : null;
  return {
    view: {
      source,
      userName,
      userEmail: str(m.user_email),
      policyName: str(m.escalation_policy_name),
      scheduleName: str(m.schedule_name),
      level: num(m.escalation_level),
      startMs: num(m.start_ms),
      endMs: num(m.end_ms),
      isMe: m.is_me === true,
      serviceNames: strList(m.service_names),
      serviceIds: strList(m.service_ids),
    },
    shift,
    fetchedMs: num(m.fetched_at_ms),
    mapComplete: m.service_map_complete !== false,
  };
}

function readRows(db: Database): Row[] {
  const rows = db
    .query("SELECT metadata FROM item WHERE type = ?")
    .all(ONCALL_SHIFT_ITEM_TYPE) as Array<{ metadata: string | null }>;
  const out: Row[] = [];
  for (const r of rows) {
    const parsed = r.metadata === null ? null : parseRow(r.metadata);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function isCurrent(r: Row, now: number): boolean {
  if (r.shift !== null) return r.shift === "current";
  const { startMs, endMs } = r.view;
  return (startMs === null || startMs <= now) && (endMs === null || now < endMs);
}

function isUpcoming(r: Row, now: number): boolean {
  if (r.shift !== null) return r.shift === "next";
  const { startMs } = r.view;
  return startMs !== null && startMs > now && startMs <= now + ONCALL_NOW_HORIZON_MS;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Rows whose value matches `term`: equality first, substring only when nothing is equal. */
function byValues(rows: readonly Row[], term: string, values: (r: Row) => string[]): Row[] {
  const eq = rows.filter((r) => values(r).some((v) => norm(v) === term));
  if (eq.length > 0) return eq;
  return rows.filter((r) => values(r).some((v) => norm(v).includes(term)));
}

type Match = { rows: Row[]; via: OncallResolvedVia };

function resolveTerm(
  rows: readonly Row[],
  rawTerm: string,
  configs: readonly OncallServiceBinding[],
): Match | null {
  const term = norm(rawTerm);
  const bound = configs.filter((c) => norm(c.serviceId) === term);
  if (bound.length > 0) {
    const ids = new Set(bound.flatMap((c) => c.pagerdutyServices.map(norm)));
    const hit = rows.filter((r) => r.view.serviceIds.some((id) => ids.has(norm(id))));
    if (hit.length > 0) return { rows: hit, via: "binding" };
  }
  const byId = rows.filter((r) => r.view.serviceIds.some((id) => norm(id) === term));
  if (byId.length > 0) return { rows: byId, via: "service_id" };
  const byName = byValues(rows, term, (r) => r.view.serviceNames);
  if (byName.length > 0) return { rows: byName, via: "service_name" };
  const byOwner = byValues(rows, term, (r) =>
    [r.view.scheduleName, r.view.policyName].filter((x): x is string => x !== null),
  );
  return byOwner.length > 0 ? { rows: byOwner, via: "schedule_or_policy" } : null;
}

function orderKey(v: OncallShiftView): string {
  return v.scheduleName ?? v.policyName ?? "";
}

function compareViews(a: OncallShiftView, b: OncallShiftView): number {
  return (
    cmp(orderKey(a), orderKey(b)) || (a.level ?? 0) - (b.level ?? 0) || cmp(a.userName, b.userName)
  );
}

function knownNames(rows: readonly Row[]): string[] {
  const names = new Set<string>();
  for (const r of rows) {
    for (const n of [r.view.scheduleName, r.view.policyName, ...r.view.serviceNames]) {
      if (n !== null) names.add(n);
    }
  }
  return [...names].sort(cmp).slice(0, ONCALL_NOW_MAX_KNOWN);
}

function sourceAges(rows: readonly Row[], now: number): OncallSourceAge[] {
  const by = new Map<OncallSource, number | null>();
  for (const r of rows) {
    const prev = by.get(r.view.source);
    if (r.fetchedMs === null) by.set(r.view.source, null);
    else if (prev === undefined) by.set(r.view.source, r.fetchedMs);
    else if (prev !== null) by.set(r.view.source, Math.min(prev, r.fetchedMs));
  }
  return [...by.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([source, oldest]) => ({
      source,
      oldestFetchedMs: oldest,
      stale: oldest === null || now - oldest > ONCALL_STALE_MS,
    }));
}

const NO_DATA_GAP =
  "No on-call shifts are indexed: connect PagerDuty or Jira Service Management " +
  "(`nimbus connector auth pagerduty` / `nimbus connector auth jira`) and let a sync run.";

function empty(opts: OncallNowOptions, status: OncallNowStatus): OncallNowResult {
  return {
    status,
    asOfMs: opts.nowMs,
    query: opts.term ?? null,
    resolvedVia: null,
    youAreOnCall: false,
    sources: [],
    shifts: [],
    next: [],
    known: [],
    gaps: status === "no_data" ? [NO_DATA_GAP] : [],
  };
}

function scoped(all: readonly Row[], opts: OncallNowOptions): Match | "no_match" {
  if (opts.pagerdutyServiceId !== undefined) {
    const id = norm(opts.pagerdutyServiceId);
    const hit = all.filter((r) => r.view.serviceIds.some((x) => norm(x) === id));
    return hit.length > 0 ? { rows: hit, via: "service_id" } : "no_match";
  }
  if (opts.term === undefined) return { rows: [...all], via: "schedule_or_policy" };
  return resolveTerm(all, opts.term, opts.serviceConfigs ?? []) ?? "no_match";
}

export function queryOncallNow(db: Database, opts: OncallNowOptions): OncallNowResult {
  const all = readRows(db);
  if (all.length === 0) return empty(opts, "no_data");
  const match = scoped(all, opts);
  if (match === "no_match") {
    return {
      ...empty(opts, "no_match"),
      known: knownNames(all),
      sources: sourceAges(all, opts.nowMs),
    };
  }
  const now = opts.nowMs;
  const current = match.rows.filter((r) => isCurrent(r, now)).map((r) => r.view);
  const upcoming = match.rows
    .filter((r) => !isCurrent(r, now) && isUpcoming(r, now))
    .map((r) => r.view);
  const shifts = current.sort(compareViews).slice(0, ONCALL_NOW_MAX_CURRENT);
  const next = upcoming.sort(compareViews).slice(0, ONCALL_NOW_MAX_UPCOMING);
  const gaps: string[] = [];
  if (match.rows.some((r) => !r.mapComplete)) {
    gaps.push(
      "The service map was incomplete for some shifts, so looking up by service may miss a schedule; try the schedule name.",
    );
  }
  return {
    status: shifts.length > 0 ? "ok" : "none_on_call",
    asOfMs: now,
    query: opts.term ?? null,
    resolvedVia:
      opts.term === undefined && opts.pagerdutyServiceId === undefined ? null : match.via,
    youAreOnCall: shifts.some((s) => s.isMe),
    sources: sourceAges(match.rows, now),
    shifts,
    next,
    known: [],
    gaps,
  };
}
