import type { Database } from "bun:sqlite";

import { metadataRecord, nonEmptyStringField } from "../agents/_lib/item-metadata.ts";
import {
  readPagerdutySyncFreshness,
  selectAllActiveIncidents,
} from "../agents/_lib/oncall-queries.ts";
import {
  type OncallNowResult,
  type OncallShiftView,
  queryOncallNow,
} from "../index/oncall-now-query.ts";
import { computeDoraMetrics, type DoraMetricValue } from "../metrics/dora.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

/**
 * The model behind `nimbus statuspage draft` (Phase 17, Wave 4): what a PUBLISHABLE status page says,
 * built from the local index only. Pure over the database and the already-loaded service configs: no
 * network, no connector, no model, no write.
 *
 * The page is meant to leave the machine (the owner publishes it), so this model is where the leak rules
 * are enforced, once, before any renderer sees a value: an e-mail address never appears anywhere (a person
 * is a display name, in the on-call section only), an incident carries its short id, status, severity,
 * service and open time and NOTHING else unless the owner asked for it (`titles`, `links`), an incident's
 * assignees and description are never read into it, and a repository is never named (a DORA row is keyed
 * by the configured service id).
 */

export const STATUSPAGE_DORA_WINDOW_DAYS = 30;
export const STATUSPAGE_MAX_INCIDENTS = 100;
export const STATUSPAGE_MAX_SERVICES = 50;
export const STATUSPAGE_MAX_NEXT_SHIFTS = 10;
export const STATUSPAGE_TITLE_MAX = 200;
/** A source whose last sync is older than this is called out as possibly out of date. */
export const STATUSPAGE_STALE_MS = 6 * 3_600_000;

const PAGERDUTY_SERVICE = "pagerduty";
const JIRA_SERVICE = "jira";

type SourceId = "pagerduty" | "jsm";

export type StatuspageIncidentKind = "pagerduty_incident" | "jsm_alert";
export type StatuspageIncidentsStatus = "open" | "none_open" | "no_data";

export interface StatuspageIncident {
  kind: StatuspageIncidentKind;
  /** The provider's short id (never an item id), capped. */
  ref: string;
  status: string | null;
  /** PagerDuty priority name or JSM alert priority. */
  severity: string | null;
  urgency: string | null;
  /** The configured service id the incident is bound to, else null. */
  service: string | null;
  openedAtMs: number | null;
  /** Only with `titles`. E-mail addresses and URLs are removed from it. */
  title?: string;
  /** Only with `links`: an http(s) URL of the source system. */
  url?: string;
}

export interface StatuspageSource {
  source: SourceId;
  indexed: boolean;
  lastSyncMs: number | null;
  stale: boolean;
  open: number;
}

export interface StatuspageShift {
  source: SourceId;
  /** A display name, or null when only an e-mail address is known (the page then says "on call"). */
  name: string | null;
  schedule: string | null;
  policy: string | null;
  level: number | null;
  startMs: number | null;
  endMs: number | null;
}

export interface StatuspageDoraCell {
  value: number | null;
  unit: string;
  sample: number;
  gap: string | null;
}

export interface StatuspageDoraRow {
  service: string;
  deployment_frequency: StatuspageDoraCell;
  lead_time_for_changes: StatuspageDoraCell;
  change_failure_rate: StatuspageDoraCell;
  mttr: StatuspageDoraCell;
}

export interface StatuspageOnCallSource {
  source: SourceId;
  oldestFetchedMs: number | null;
  stale: boolean;
}

export interface StatuspageModel {
  generatedAtMs: number;
  generatedAt: string;
  options: { services: string[]; titles: boolean; links: boolean };
  incidents: {
    status: StatuspageIncidentsStatus;
    total: number;
    items: StatuspageIncident[];
    sources: StatuspageSource[];
  };
  onCall: {
    status: "ok" | "none_on_call" | "no_match" | "no_data";
    shifts: StatuspageShift[];
    next: StatuspageShift[];
    sources: StatuspageOnCallSource[];
  };
  dora: {
    status: "ok" | "no_services" | "config_error";
    windowDays: number;
    rows: StatuspageDoraRow[];
  };
  gaps: string[];
}

export interface StatuspageOptions {
  nowMs: number;
  /** Configured service ids to restrict the page to; empty = every configured service. */
  services?: readonly string[];
  titles?: boolean;
  links?: boolean;
  serviceConfigs: ReadonlyMap<string, ServiceConfig>;
  /** Set when `nimbus.toml`'s service blocks could not be read. */
  configError?: boolean;
}

/**
 * A maximal run of characters that can belong to an e-mail address. One greedy class and nothing after
 * it, so the scan is linear (an `x+@y+` pattern backtracks quadratically over a long run with no `@`).
 */
const ADDRESS_RUN = /[^\s<>()"',;:]+/g;
const URL_LIKE = /\b(?:https?|ftp):\/\/\S+/gi;

/** True when the run holds an `@` with at least one character on each side, i.e. it reads as an address. */
function looksLikeAddress(run: string): boolean {
  const at = run.indexOf("@", 1);
  return at !== -1 && at < run.length - 1;
}

/** Removes e-mail addresses and (unless `keepUrls`) URLs from an index string, flattens it and caps it. */
export function scrubPublicText(raw: string, max: number, keepUrls = false): string {
  let s = raw.replaceAll(ADDRESS_RUN, (run) => (looksLikeAddress(run) ? "[redacted]" : run));
  if (!keepUrls) s = s.replaceAll(URL_LIKE, "[link removed]");
  s = s.replaceAll(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function publicName(raw: string | null): string | null {
  if (raw === null) return null;
  const s = scrubPublicText(raw, 80);
  return s === "" ? null : s;
}

/** A display name only: null when the value is, or contains, an e-mail address. */
function personName(raw: string): string | null {
  if (raw.includes("@")) return null;
  return publicName(raw);
}

function shortRef(raw: string): string {
  const tail = raw.slice(raw.lastIndexOf(":") + 1);
  return tail.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
}

function safeHttpUrl(url: string | null): string | undefined {
  if (url === null) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function selectConfigs(
  all: ReadonlyMap<string, ServiceConfig>,
  requested: readonly string[],
): { chosen: ServiceConfig[]; unknown: string[] } {
  const list = [...all.values()].sort((a, b) => codeUnitCompare(a.serviceId, b.serviceId));
  if (requested.length === 0) return { chosen: list, unknown: [] };
  const chosen = new Map<string, ServiceConfig>();
  const unknown: string[] = [];
  for (const term of requested) {
    const hit = list.find((c) => norm(c.serviceId) === norm(term));
    if (hit === undefined) unknown.push(term);
    else chosen.set(hit.serviceId, hit);
  }
  return { chosen: [...chosen.values()], unknown };
}

function countItems(db: Database, service: string, type: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM item WHERE service = ? AND type = ?")
    .get(service, type) as { n: number } | null;
  return row?.n ?? 0;
}

function lastSyncOf(db: Database, connectorId: string): number | null {
  const row = db
    .query("SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1")
    .get(connectorId) as { last_sync_at: number | null } | null;
  const v = row?.last_sync_at;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

type AlertRow = { id: string; title: string; metadata: string | null };
type OpenAlert = { row: AlertRow; meta: Record<string, unknown> };

function readOpenAlerts(db: Database): { open: OpenAlert[]; total: number } {
  const rows = db
    .query("SELECT id, title, metadata FROM item WHERE service = ? AND type = 'alert'")
    .all(JIRA_SERVICE) as AlertRow[];
  const open: OpenAlert[] = [];
  for (const row of rows) {
    const meta = metadataRecord(row.metadata);
    if (meta === null) continue;
    // A closed alert is `status: "closed"`; a missing status counts as open (hiding a live alert is
    // the worse error, as for PagerDuty incidents).
    if (norm(nonEmptyStringField(meta, "status") ?? "") !== "closed") open.push({ row, meta });
  }
  return { open, total: rows.length };
}

function alertTags(meta: Record<string, unknown>): string[] {
  // lane-census: scope=alert service=jira
  const t = meta["tags"];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string").map(norm) : [];
}

function byOpened(a: StatuspageIncident, b: StatuspageIncident): number {
  if (a.openedAtMs === null && b.openedAtMs === null) return codeUnitCompare(a.ref, b.ref);
  if (a.openedAtMs === null) return 1;
  if (b.openedAtMs === null) return -1;
  return b.openedAtMs - a.openedAtMs || codeUnitCompare(a.ref, b.ref);
}

type ServiceFilter = { pd: Set<string>; tags: Set<string> };

function pagerdutyIncidents(
  db: Database,
  opts: StatuspageOptions,
  filter: ServiceFilter | null,
  resolver: ReturnType<typeof buildServiceIdentityResolver>,
): StatuspageIncident[] {
  const out: StatuspageIncident[] = [];
  for (const i of selectAllActiveIncidents(db)) {
    if (
      filter !== null &&
      !(i.pagerdutyServiceId !== null && filter.pd.has(i.pagerdutyServiceId))
    ) {
      continue;
    }
    const res = resolver({
      service: PAGERDUTY_SERVICE,
      type: "incident",
      metadata: i.pagerdutyServiceId === null ? {} : { pagerduty_service_id: i.pagerdutyServiceId },
    });
    const url = opts.links === true ? safeHttpUrl(i.url) : undefined;
    out.push({
      kind: "pagerduty_incident",
      ref: shortRef(i.id),
      status: publicName(i.status),
      severity: publicName(i.severity),
      urgency: publicName(i.urgency),
      service: res.kind === "bound" ? res.serviceId : null,
      openedAtMs: i.openedAtMs,
      ...(opts.titles === true
        ? { title: scrubPublicText(i.title, STATUSPAGE_TITLE_MAX, opts.links === true) }
        : {}),
      ...(url === undefined ? {} : { url }),
    });
  }
  return out;
}

function jsmAlerts(
  alerts: readonly OpenAlert[],
  opts: StatuspageOptions,
  filter: ServiceFilter | null,
  resolver: ReturnType<typeof buildServiceIdentityResolver>,
): StatuspageIncident[] {
  const out: StatuspageIncident[] = [];
  for (const { row, meta } of alerts) {
    if (filter !== null && !alertTags(meta).some((t) => filter.tags.has(t))) continue;
    const res = resolver({ service: JIRA_SERVICE, type: "alert", metadata: meta });
    // lane-census: scope=alert service=jira
    const opened = meta["opened_at_ms"];
    out.push({
      kind: "jsm_alert",
      ref: shortRef(nonEmptyStringField(meta, "alert_id") ?? row.id),
      status: publicName(nonEmptyStringField(meta, "status")),
      severity: publicName(nonEmptyStringField(meta, "priority")),
      urgency: null,
      service: res.kind === "bound" ? res.serviceId : null,
      openedAtMs: typeof opened === "number" && Number.isFinite(opened) ? opened : null,
      ...(opts.titles === true
        ? { title: scrubPublicText(row.title, STATUSPAGE_TITLE_MAX, opts.links === true) }
        : {}),
    });
  }
  return out;
}

function toShift(s: OncallShiftView): StatuspageShift {
  return {
    source: s.source,
    name: personName(s.userName),
    schedule: publicName(s.scheduleName),
    policy: publicName(s.policyName),
    level: s.level,
    startMs: s.startMs,
    endMs: s.endMs,
  };
}

function dedupe(list: StatuspageShift[]): StatuspageShift[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = JSON.stringify([s.source, s.schedule, s.policy, s.level, s.name, s.startMs, s.endMs]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeSources(results: readonly OncallNowResult[]): StatuspageOnCallSource[] {
  const by = new Map<SourceId, StatuspageOnCallSource>();
  for (const r of results) {
    for (const a of r.sources) {
      const prev = by.get(a.source);
      if (prev === undefined) {
        by.set(a.source, { source: a.source, oldestFetchedMs: a.oldestFetchedMs, stale: a.stale });
        continue;
      }
      const oldest =
        prev.oldestFetchedMs === null || a.oldestFetchedMs === null
          ? null
          : Math.min(prev.oldestFetchedMs, a.oldestFetchedMs);
      by.set(a.source, { source: a.source, oldestFetchedMs: oldest, stale: prev.stale || a.stale });
    }
  }
  return [...by.values()].sort((a, b) => codeUnitCompare(a.source, b.source));
}

function gatherOnCall(
  db: Database,
  opts: StatuspageOptions,
  chosen: readonly ServiceConfig[],
  scoped: boolean,
  gaps: string[],
): StatuspageModel["onCall"] {
  const bindings = [...opts.serviceConfigs.values()].map((c) => ({
    serviceId: c.serviceId,
    pagerdutyServices: c.pagerdutyServices,
  }));
  const results: OncallNowResult[] = [];
  if (scoped) {
    for (const c of chosen) {
      const r = queryOncallNow(db, {
        nowMs: opts.nowMs,
        term: c.serviceId,
        serviceConfigs: bindings,
      });
      if (r.status === "no_match")
        gaps.push(`No on-call schedule is mapped to service "${c.serviceId}".`);
      else results.push(r);
    }
  } else {
    results.push(queryOncallNow(db, { nowMs: opts.nowMs, serviceConfigs: bindings }));
  }
  const shifts = dedupe(results.flatMap((r) => r.shifts.map(toShift)));
  const next = dedupe(results.flatMap((r) => r.next.map(toShift))).slice(
    0,
    STATUSPAGE_MAX_NEXT_SHIFTS,
  );
  let status: StatuspageModel["onCall"]["status"];
  if (results.length === 0) status = "no_match";
  else if (results.some((r) => r.status === "no_data")) status = "no_data";
  else status = shifts.length > 0 ? "ok" : "none_on_call";
  return { status, shifts, next, sources: mergeSources(results) };
}

function cell(m: DoraMetricValue): StatuspageDoraCell {
  return { value: m.value, unit: m.unit, sample: m.sample, gap: m.gap };
}

function gatherDora(
  db: Database,
  opts: StatuspageOptions,
  chosen: readonly ServiceConfig[],
): StatuspageModel["dora"] {
  const windowDays = STATUSPAGE_DORA_WINDOW_DAYS;
  if (opts.configError === true) return { status: "config_error", windowDays, rows: [] };
  if (chosen.length === 0) return { status: "no_services", windowDays, rows: [] };
  const rows = chosen.slice(0, STATUSPAGE_MAX_SERVICES).map((cfg) => {
    const r = computeDoraMetrics(db, cfg, opts.nowMs, windowDays * 86_400_000);
    return {
      service: cfg.serviceId,
      deployment_frequency: cell(r.metrics.deployment_frequency),
      lead_time_for_changes: cell(r.metrics.lead_time_for_changes),
      change_failure_rate: cell(r.metrics.change_failure_rate),
      mttr: cell(r.metrics.mttr),
    };
  });
  return { status: "ok", windowDays, rows };
}

function sourceState(
  source: SourceId,
  indexed: boolean,
  lastSyncMs: number | null,
  open: number,
  nowMs: number,
): StatuspageSource {
  const stale = lastSyncMs !== null && nowMs - lastSyncMs > STATUSPAGE_STALE_MS;
  return { source, indexed, lastSyncMs, stale, open };
}

const SOURCE_NAME: Record<SourceId, string> = {
  pagerduty: "PagerDuty",
  jsm: "Jira Service Management",
};

/** The gaps that come from the service configuration itself, before anything is read. */
function pushConfigGaps(gaps: string[], opts: StatuspageOptions, unknown: readonly string[]): void {
  for (const u of unknown)
    gaps.push(`Service "${u}" is not configured, so it is not on this page.`);
  if (opts.configError === true) {
    gaps.push(
      "The service configuration in nimbus.toml could not be read, so no services are listed.",
    );
  } else if (opts.serviceConfigs.size === 0) {
    gaps.push(
      "No services are configured ([metrics.dora.<id>] or [ci.service.<id>] in nimbus.toml).",
    );
  }
}

/** The incidents section and its gaps (what is not indexed, what is stale, what is cut). */
function gatherIncidents(
  db: Database,
  opts: StatuspageOptions,
  filter: ServiceFilter | null,
  gaps: string[],
): StatuspageModel["incidents"] {
  const resolver = buildServiceIdentityResolver(opts.serviceConfigs);
  const alerts = readOpenAlerts(db);
  const pd = pagerdutyIncidents(db, opts, filter, resolver);
  const jsm = jsmAlerts(alerts.open, opts, filter, resolver);
  const items = [...pd, ...jsm].sort(byOpened);

  const pdFresh = readPagerdutySyncFreshness(db, opts.nowMs);
  const pdIndexed = pdFresh.reason === null || countItems(db, PAGERDUTY_SERVICE, "incident") > 0;
  const jsmIndexed = alerts.total > 0;
  const sources = [
    sourceState("pagerduty", pdIndexed, pdFresh.lastSyncMs, pd.length, opts.nowMs),
    sourceState(
      "jsm",
      jsmIndexed,
      jsmIndexed ? lastSyncOf(db, JIRA_SERVICE) : null,
      jsm.length,
      opts.nowMs,
    ),
  ];
  let status: StatuspageIncidentsStatus = "open";
  if (!pdIndexed && !jsmIndexed) status = "no_data";
  else if (items.length === 0) status = "none_open";
  if (!pdIndexed) {
    gaps.push("No PagerDuty incident data is indexed (connect PagerDuty and let a sync run).");
  }
  if (!jsmIndexed) {
    gaps.push("No Jira Service Management alert data is indexed, so open alerts are not shown.");
  }
  for (const s of sources) {
    if (s.stale) {
      gaps.push(
        `${SOURCE_NAME[s.source]} data was last synced more than 6 hours before this page was generated.`,
      );
    }
  }
  if (items.length > STATUSPAGE_MAX_INCIDENTS) {
    gaps.push(
      `Only the newest ${String(STATUSPAGE_MAX_INCIDENTS)} of ${String(items.length)} open incidents are listed.`,
    );
  }
  return {
    status,
    total: items.length,
    items: items.slice(0, STATUSPAGE_MAX_INCIDENTS),
    sources,
  };
}

export function buildStatuspageModel(db: Database, opts: StatuspageOptions): StatuspageModel {
  const gaps: string[] = [];
  const requested = opts.services ?? [];
  const { chosen, unknown } = selectConfigs(opts.serviceConfigs, requested);
  pushConfigGaps(gaps, opts, unknown);
  const scoped = requested.length > 0;
  const filter: ServiceFilter | null = scoped
    ? {
        pd: new Set(chosen.flatMap((c) => [...c.pagerdutyServices])),
        tags: new Set(chosen.flatMap((c) => c.jsmAlertTags.map(norm))),
      }
    : null;
  const incidents = gatherIncidents(db, opts, filter, gaps);
  if (chosen.length > STATUSPAGE_MAX_SERVICES) {
    gaps.push(`Only the first ${String(STATUSPAGE_MAX_SERVICES)} services are scored.`);
  }
  const onCall = gatherOnCall(db, opts, chosen, scoped, gaps);
  if (onCall.status === "no_data") gaps.push("No on-call shifts are indexed.");
  if (onCall.sources.some((s) => s.stale)) {
    gaps.push("On-call data is more than an hour old; the shift may have changed.");
  }
  return {
    generatedAtMs: opts.nowMs,
    generatedAt: new Date(opts.nowMs).toISOString(),
    options: {
      services: chosen.map((c) => c.serviceId),
      titles: opts.titles === true,
      links: opts.links === true,
    },
    incidents,
    onCall,
    dora: gatherDora(db, opts, chosen),
    gaps,
  };
}
