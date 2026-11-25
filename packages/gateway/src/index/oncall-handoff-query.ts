import type { Database } from "bun:sqlite";

import { dueInstant } from "../briefing/briefing-due.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { gatewayZone } from "../util/zoned-time.ts";
import { CREATED_KEY, DELETED_KEY } from "./item-history.ts";
import { earliestHistoryMs } from "./item-history-at.ts";
import { fmtUtc, handoffGaps } from "./oncall-handoff-gaps.ts";
import { queryOncallNow } from "./oncall-now-query.ts";
import { ONCALL_SOURCE_SERVICE, type OncallSource } from "./oncall-shift-types.ts";
import { listWorkSnapshot, type WorkSnapshotService } from "./work-snapshot-store.ts";

/**
 * The on-call handoff brief (Phase 17): what happened during a shift and what the next person inherits,
 * answered from the LOCAL INDEX ONLY. Pure over the database: reads only, no network, no connector, no
 * model, no clock of its own (`nowMs` is a parameter).
 *
 * Sources: PagerDuty incidents and Jira Service Management Operations alerts (the item rows and their
 * `item_history` state changes, V94), `oncall_shift` rows (who is on call), `deployment_items`, and the
 * `work_snapshot` of the owner's assigned work. Every section that cannot be answered says so in `gaps`:
 * an empty list is never printed as "nothing happened" unless the substrate to see it exists.
 */

export const HANDOFF_DEFAULT_WINDOW_MS = 12 * 3_600_000;
export const HANDOFF_MAX_SHIFT_WINDOW_MS = 7 * 86_400_000;
export const HANDOFF_MAX_WINDOW_MS = 31 * 86_400_000;
export const HANDOFF_LIST_CAP = 50;
export const HANDOFF_DUE_HORIZON_MS = 24 * 3_600_000;
export const HANDOFF_SHIFT_CAP = 10;
export const HANDOFF_KNOWN_CAP = 20;
const FLAP_MIN_STATUS_CHANGES = 2;

export type HandoffSource = "pagerduty" | "jsm";
export type HandoffWindowBasis = "explicit" | "own_shift" | "default";

export interface HandoffWindow {
  fromMs: number;
  toMs: number;
  basis: HandoffWindowBasis;
  /** One sentence saying which window was used and why. */
  reason: string;
}

/** What a service filter needs from `[ci.service.<id>]` / `[metrics.dora.<id>]`. */
export interface HandoffServiceBinding {
  serviceId: string;
  pagerdutyServices: readonly string[];
  jsmAlertTags: readonly string[];
  incidentWindowMinutes: number;
}

export interface HandoffShift {
  source: OncallSource;
  userName: string;
  scheduleName: string | null;
  policyName: string | null;
  level: number | null;
  startMs: number | null;
  endMs: number | null;
  isMe: boolean;
}

export interface HandoffShiftSection {
  status: "ok" | "none_on_call" | "no_match" | "no_data";
  mine: HandoffShift[];
  onCallNow: HandoffShift[];
  next: HandoffShift[];
  sources: Array<{ source: OncallSource; oldestFetchedMs: number | null; stale: boolean }>;
}

export type HandoffEventKind = "opened" | "state_changed" | "resolved" | "removed";

export interface HandoffEvent {
  kind: HandoffEventKind;
  source: HandoffSource;
  itemId: string;
  title: string;
  url: string | null;
  atMs: number;
  /** `provider`: the provider's own time. `observed`: the time the sync saw it, which can be later. */
  atBasis: "provider" | "observed";
  key: string | null;
  from: string | null;
  to: string | null;
}

export interface HandoffOpenItem {
  source: HandoffSource;
  itemId: string;
  title: string;
  url: string | null;
  status: string | null;
  severity: string | null;
  openedAtMs: number | null;
  acknowledged: boolean | null;
}

export interface HandoffDeployment {
  id: string;
  title: string;
  url: string | null;
  serviceId: string;
  environment: string;
  provider: string;
  conclusion: string;
  startedAtMs: number;
  sha: string;
}

export type HandoffWatchReason = "reopened" | "changed_state_repeatedly";

export interface HandoffWatchItem {
  reason: HandoffWatchReason;
  source: HandoffSource;
  itemId: string;
  title: string;
  url: string | null;
  detail: string;
}

export interface HandoffDeployCorrelation {
  deployment: HandoffDeployment;
  items: Array<{
    source: HandoffSource;
    itemId: string;
    title: string;
    openedAtMs: number;
    stillOpen: boolean;
  }>;
}

export interface HandoffDueItem {
  service: WorkSnapshotService;
  itemId: string;
  title: string;
  url: string | null;
  dueMs: number;
  overdue: boolean;
}

export interface HandoffGap {
  code: string;
  detail: string;
}

export interface HandoffFreshness {
  source: string;
  lastSyncMs: number | null;
}

export interface HandoffCounted<T> {
  items: T[];
  total: number;
}

export interface OncallHandoffResult {
  status: "ok" | "no_match";
  asOfMs: number;
  window: HandoffWindow;
  service: string | null;
  /** `no_match` only: configured service ids to retry with. */
  known: string[];
  shift: HandoffShiftSection;
  events: HandoffCounted<HandoffEvent>;
  deployments: HandoffCounted<HandoffDeployment>;
  stillOpen: HandoffCounted<HandoffOpenItem>;
  watch: {
    flagged: HandoffCounted<HandoffWatchItem>;
    deploysWithIncidents: HandoffCounted<HandoffDeployCorrelation>;
    due: HandoffCounted<HandoffDueItem>;
  };
  freshness: HandoffFreshness[];
  historyStartsMs: number | null;
  gaps: HandoffGap[];
}

export interface OncallHandoffOptions {
  nowMs: number;
  sinceMs?: number;
  untilMs?: number;
  /** A configured service id (or a PagerDuty service id). Absent = everything indexed. */
  service?: string;
  serviceConfigs?: readonly HandoffServiceBinding[];
  /** IANA zone for date-only due dates; defaults to the gateway zone. */
  zone?: string;
}

type ItemRow = {
  id: string;
  title: string;
  url: string | null;
  metadata: string | null;
};

type Tracked = {
  source: HandoffSource;
  itemId: string;
  title: string;
  url: string | null;
  status: string | null;
  severity: string | null;
  openedAtMs: number | null;
  /** The provider's resolution/close time, when the row carries one. */
  endedAtMs: number | null;
  ended: boolean;
  acknowledged: boolean | null;
  pagerdutyServiceId: string | null;
  tags: readonly string[];
};

type HistoryRow = {
  item_id: string;
  service: string;
  type: string;
  key: string;
  old_value: string | null;
  new_value: string | null;
  observed_at_ms: number;
  source_at_ms: number | null;
};

const NOISE_KEYS: ReadonlySet<string> = new Set([
  "resolved_by_email",
  "status_category",
  "resolved_at_ms",
]);
const ENDED_VALUES: ReadonlySet<string> = new Set(["resolved", "closed"]);

function record(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(m: Record<string, unknown>, k: string): string | null {
  const v = m[k];
  return typeof v === "string" && v !== "" ? v : null;
}

function num(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sourceOf(service: string): HandoffSource {
  return service === "pagerduty" ? "pagerduty" : "jsm";
}

function readTracked(db: Database, source: HandoffSource): Tracked[] {
  const service = ONCALL_SOURCE_SERVICE[source];
  const type = source === "pagerduty" ? "incident" : "alert";
  const rows = db
    .query("SELECT id, title, url, metadata FROM item WHERE service = ? AND type = ?")
    .all(service, type) as ItemRow[];
  const out: Tracked[] = [];
  for (const r of rows) {
    const m = record(r.metadata);
    if (m === null) continue;
    const status = str(m, "status");
    const lower = status?.toLowerCase() ?? null;
    const endedValue = source === "pagerduty" ? "resolved" : "closed";
    out.push({
      source,
      itemId: r.id,
      title: r.title,
      url: r.url,
      status,
      severity: str(m, source === "pagerduty" ? "severity" : "priority"),
      openedAtMs: num(m, "opened_at_ms"),
      endedAtMs: num(m, source === "pagerduty" ? "resolved_at_ms" : "closed_at_ms"),
      ended: lower === endedValue,
      acknowledged: typeof m["acknowledged"] === "boolean" ? m["acknowledged"] : null,
      pagerdutyServiceId: str(m, "pagerduty_service_id"),
      tags: Array.isArray(m["tags"])
        ? (m["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
        : [],
    });
  }
  return out;
}

function capped<T>(all: readonly T[]): HandoffCounted<T> {
  return { items: all.slice(0, HANDOFF_LIST_CAP), total: all.length };
}

function toShift(s: {
  source: OncallSource;
  userName: string;
  scheduleName: string | null;
  policyName: string | null;
  level: number | null;
  startMs: number | null;
  endMs: number | null;
  isMe: boolean;
}): HandoffShift {
  return {
    source: s.source,
    userName: s.userName,
    scheduleName: s.scheduleName,
    policyName: s.policyName,
    level: s.level,
    startMs: s.startMs,
    endMs: s.endMs,
    isMe: s.isMe,
  };
}

function resolveWindow(
  opts: OncallHandoffOptions,
  mine: readonly HandoffShift[],
  hasAnyShiftRows: boolean,
): HandoffWindow {
  const now = opts.nowMs;
  const { sinceMs, untilMs } = opts;
  if (sinceMs !== undefined || untilMs !== undefined) {
    const toMs = untilMs ?? now;
    const fromMs = sinceMs ?? toMs - HANDOFF_DEFAULT_WINDOW_MS;
    const sinceReason =
      untilMs === undefined
        ? "You gave the window with --since; it ends now."
        : "You gave the window with --since and --until.";
    const reason =
      sinceMs === undefined
        ? `You gave only --until, so the window is the ${String(HANDOFF_DEFAULT_WINDOW_MS / 3_600_000)} hours before it.`
        : sinceReason;
    return { fromMs, toMs, basis: "explicit", reason };
  }
  const starts = mine
    .filter((s) => s.startMs !== null && s.startMs <= now)
    .map((s) => s.startMs as number);
  if (starts.length > 0) {
    const first = Math.min(...starts);
    const fromMs = Math.max(first, now - HANDOFF_MAX_SHIFT_WINDOW_MS);
    const cappedNote =
      fromMs === first
        ? ""
        : ` Your shift began ${fmtUtc(first)}, earlier than the ${String(HANDOFF_MAX_SHIFT_WINDOW_MS / 86_400_000)}-day limit, so the window starts at the limit.`;
    return {
      fromMs,
      toMs: now,
      basis: "own_shift",
      reason: `Your current on-call shift began ${fmtUtc(first)}; the window runs from there to now.${cappedNote}`,
    };
  }
  let why: string;
  if (!hasAnyShiftRows) {
    why = "no on-call shifts are indexed";
  } else if (mine.length > 0) {
    why = "your shift carries no start time (Jira Service Management shifts have none)";
  } else {
    why = "no indexed shift is marked as yours";
  }
  return {
    fromMs: now - HANDOFF_DEFAULT_WINDOW_MS,
    toMs: now,
    basis: "default",
    reason: `The last ${String(HANDOFF_DEFAULT_WINDOW_MS / 3_600_000)} hours, because ${why}.`,
  };
}

type Scope = {
  pdIds: ReadonlySet<string> | null;
  tags: ReadonlySet<string> | null;
  serviceIds: ReadonlySet<string> | null;
};

function resolveScope(
  service: string | undefined,
  configs: readonly HandoffServiceBinding[],
): Scope | "no_match" {
  if (service === undefined) return { pdIds: null, tags: null, serviceIds: null };
  const term = service.trim().toLowerCase();
  const cfg = configs.filter((c) => c.serviceId.toLowerCase() === term);
  if (cfg.length > 0) {
    return {
      pdIds: new Set(cfg.flatMap((c) => c.pagerdutyServices)),
      tags: new Set(cfg.flatMap((c) => c.jsmAlertTags.map((t) => t.trim().toLowerCase()))),
      serviceIds: new Set(cfg.map((c) => c.serviceId)),
    };
  }
  const byPd = configs.filter((c) => c.pagerdutyServices.some((p) => p.toLowerCase() === term));
  if (byPd.length > 0) {
    return {
      pdIds: new Set([service.trim()]),
      tags: new Set(),
      serviceIds: new Set(byPd.map((c) => c.serviceId)),
    };
  }
  return "no_match";
}

/**
 * The configured service ids a `service` argument resolves to (the same rule the item lanes use), `null` for no
 * filter, `"no_match"` when it names nothing configured. The incident-record sections (IC9a) filter on it.
 */
export function handoffServiceIds(
  service: string | undefined,
  configs: readonly HandoffServiceBinding[],
): ReadonlySet<string> | null | "no_match" {
  const scope = resolveScope(service, configs);
  return scope === "no_match" ? "no_match" : scope.serviceIds;
}

function inScope(t: Tracked, scope: Scope): boolean {
  if (scope.pdIds === null) return true;
  if (t.source === "pagerduty") {
    return t.pagerdutyServiceId !== null && scope.pdIds.has(t.pagerdutyServiceId);
  }
  return t.tags.some((tag) => scope.tags?.has(tag.trim().toLowerCase()) === true);
}

function readHistory(db: Database, fromMs: number): HistoryRow[] {
  return db
    .query(
      `SELECT item_id, service, type, key, old_value, new_value, observed_at_ms, source_at_ms
         FROM item_history
        WHERE ((service = 'pagerduty' AND type = 'incident') OR (service = 'jira' AND type = 'alert'))
          AND observed_at_ms >= ?
        ORDER BY observed_at_ms, id`,
    )
    .all(fromMs) as HistoryRow[];
}

/** What `buildEvents` accumulates: the events, every history row by item, and which items it saw open or end. */
type EventScan = {
  readonly events: HandoffEvent[];
  readonly byItem: Map<string, HistoryRow[]>;
  readonly openedSeen: Set<string>;
  readonly resolvedSeen: Set<string>;
};

/** An event with no state key (an open, a removal or a provider-time resolution). */
function itemEvent(
  tracked: ReadonlyMap<string, Tracked>,
  itemId: string,
  source: HandoffSource,
  at: Pick<HandoffEvent, "kind" | "atMs" | "atBasis"> & Partial<Pick<HandoffEvent, "key" | "to">>,
): HandoffEvent {
  const t = tracked.get(itemId);
  return {
    source,
    itemId,
    title: t?.title ?? itemId,
    url: t?.url ?? null,
    kind: at.kind,
    atMs: at.atMs,
    atBasis: at.atBasis,
    key: at.key ?? null,
    from: null,
    to: at.to ?? null,
  };
}

/** One `item_history` row: kept by item for the watch-list, and an event when it falls in the window. */
function historyRowEvent(
  tracked: ReadonlyMap<string, Tracked>,
  h: HistoryRow,
  inWin: (ms: number) => boolean,
  scan: EventScan,
): void {
  const t = tracked.get(h.item_id);
  const source = sourceOf(h.service);
  const list = scan.byItem.get(h.item_id) ?? [];
  list.push(h);
  scan.byItem.set(h.item_id, list);
  const atMs = h.source_at_ms ?? h.observed_at_ms;
  const atBasis = h.source_at_ms === null ? "observed" : "provider";
  if (!inWin(atMs)) return;
  if (h.key === CREATED_KEY) {
    // A `__created` row for an item whose provider open time is known and outside the window is a
    // backfill of an old item, not an open during the shift.
    if ((t?.openedAtMs === null || t === undefined) && !scan.openedSeen.has(h.item_id)) {
      scan.openedSeen.add(h.item_id);
      scan.events.push(itemEvent(tracked, h.item_id, source, { kind: "opened", atMs, atBasis }));
    }
    return;
  }
  if (h.key === DELETED_KEY) {
    scan.events.push(itemEvent(tracked, h.item_id, source, { kind: "removed", atMs, atBasis }));
    return;
  }
  if (NOISE_KEYS.has(h.key)) return;
  const ended =
    h.key === "status" && h.new_value !== null && ENDED_VALUES.has(h.new_value.toLowerCase());
  if (ended) scan.resolvedSeen.add(h.item_id);
  scan.events.push({
    source,
    itemId: h.item_id,
    title: t?.title ?? h.item_id,
    url: t?.url ?? null,
    kind: ended ? "resolved" : "state_changed",
    atMs,
    atBasis,
    key: h.key,
    from: h.old_value,
    to: h.new_value,
  });
}

function buildEvents(
  tracked: ReadonlyMap<string, Tracked>,
  history: readonly HistoryRow[],
  win: HandoffWindow,
  scope: Scope,
): { events: HandoffEvent[]; byItem: Map<string, HistoryRow[]> } {
  const inWin = (ms: number): boolean => ms >= win.fromMs && ms <= win.toMs;
  const scan: EventScan = {
    events: [],
    byItem: new Map(),
    openedSeen: new Set(),
    resolvedSeen: new Set(),
  };
  const { events } = scan;

  // Opens read from the provider's own time first.
  for (const t of tracked.values()) {
    if (!inScope(t, scope) || t.openedAtMs === null || !inWin(t.openedAtMs)) continue;
    scan.openedSeen.add(t.itemId);
    events.push(
      itemEvent(tracked, t.itemId, t.source, {
        kind: "opened",
        atMs: t.openedAtMs,
        atBasis: "provider",
      }),
    );
  }

  for (const h of history) {
    const t = tracked.get(h.item_id);
    if (t !== undefined && !inScope(t, scope)) continue;
    if (t === undefined && scope.pdIds !== null) continue;
    historyRowEvent(tracked, h, inWin, scan);
  }

  // An item that is ended now, whose provider end time is in the window and that has no history row
  // for it (history begins at the V94 upgrade): read the provider's own time.
  for (const t of tracked.values()) {
    if (!inScope(t, scope) || !t.ended || t.endedAtMs === null || !inWin(t.endedAtMs)) continue;
    if (scan.resolvedSeen.has(t.itemId)) continue;
    events.push(
      itemEvent(tracked, t.itemId, t.source, {
        kind: "resolved",
        atMs: t.endedAtMs,
        atBasis: "provider",
        key: "status",
        to: t.status,
      }),
    );
  }

  events.sort((a, b) => a.atMs - b.atMs || codeUnitCompare(a.itemId, b.itemId));
  return { events, byItem: scan.byItem };
}

function watchFlags(
  tracked: ReadonlyMap<string, Tracked>,
  byItem: ReadonlyMap<string, readonly HistoryRow[]>,
  win: HandoffWindow,
): HandoffWatchItem[] {
  const out: HandoffWatchItem[] = [];
  for (const [itemId, rows] of byItem) {
    const status = rows.filter(
      (r) => r.key === "status" && r.observed_at_ms >= win.fromMs && r.observed_at_ms <= win.toMs,
    );
    if (status.length === 0) continue;
    const t = tracked.get(itemId);
    const source = status[0] === undefined ? "pagerduty" : sourceOf(status[0].service);
    const base = { source, itemId, title: t?.title ?? itemId, url: t?.url ?? null };
    const reopened = status.find(
      (r) =>
        r.old_value !== null &&
        ENDED_VALUES.has(r.old_value.toLowerCase()) &&
        (r.new_value === null || !ENDED_VALUES.has(r.new_value.toLowerCase())),
    );
    if (reopened !== undefined) {
      out.push({
        ...base,
        reason: "reopened",
        detail: `status went ${reopened.old_value ?? "?"} -> ${reopened.new_value ?? "unknown"} at ${fmtUtc(reopened.observed_at_ms)} (observed)`,
      });
    } else if (status.length >= FLAP_MIN_STATUS_CHANGES) {
      out.push({
        ...base,
        reason: "changed_state_repeatedly",
        detail: `status changed ${String(status.length)} times: ${status
          .map((r) => `${r.old_value ?? "?"} -> ${r.new_value ?? "unknown"}`)
          .join(", ")}`,
      });
    }
  }
  return out.sort((a, b) => codeUnitCompare(a.itemId, b.itemId));
}

function openAt(t: Tracked, toMs: number, atNow: boolean): "open" | "closed" | "unknown" {
  if (t.openedAtMs !== null && t.openedAtMs > toMs) return "closed";
  if (atNow) return t.ended ? "closed" : "open";
  if (!t.ended) return "open";
  if (t.endedAtMs === null) return "unknown";
  return t.endedAtMs <= toMs ? "closed" : "open";
}

function readDeployments(
  db: Database,
  win: HandoffWindow,
  scope: Scope,
): { all: HandoffDeployment[]; anyIndexed: boolean } {
  const anyIndexed =
    (db.query("SELECT 1 AS x FROM deployment_items LIMIT 1").get() as { x: number } | null) !==
    null;
  const rows = db
    .query(
      `SELECT d.id, d.provider, d.nimbus_service_id, d.environment, d.sha, d.started_at_ms,
              d.conclusion, i.title AS title, i.url AS url
         FROM deployment_items d
         LEFT JOIN item i ON i.id = d.id
        WHERE d.started_at_ms >= ? AND d.started_at_ms <= ?
        ORDER BY d.started_at_ms, d.id`,
    )
    .all(win.fromMs, win.toMs) as Array<{
    id: string;
    provider: string;
    nimbus_service_id: string;
    environment: string;
    sha: string;
    started_at_ms: number;
    conclusion: string;
    title: string | null;
    url: string | null;
  }>;
  const all = rows
    .filter((r) => scope.serviceIds === null || scope.serviceIds.has(r.nimbus_service_id))
    .map((r) => ({
      id: r.id,
      title: r.title ?? r.id,
      url: r.url,
      serviceId: r.nimbus_service_id,
      environment: r.environment,
      provider: r.provider,
      conclusion: r.conclusion,
      startedAtMs: r.started_at_ms,
      sha: r.sha,
    }));
  return { all, anyIndexed };
}

function correlate(
  deployments: readonly HandoffDeployment[],
  tracked: readonly Tracked[],
  configs: readonly HandoffServiceBinding[],
  win: HandoffWindow,
  atNow: boolean,
): HandoffDeployCorrelation[] {
  const out: HandoffDeployCorrelation[] = [];
  for (const d of deployments) {
    const cfg = configs.find((c) => c.serviceId === d.serviceId);
    if (cfg === undefined) continue;
    const spanMs = cfg.incidentWindowMinutes * 60_000;
    const tags = new Set(cfg.jsmAlertTags.map((t) => t.trim().toLowerCase()));
    const items = tracked
      .filter((t) => {
        if (t.openedAtMs === null) return false;
        if (t.openedAtMs < d.startedAtMs || t.openedAtMs > d.startedAtMs + spanMs) return false;
        if (t.source === "pagerduty") {
          return (
            t.pagerdutyServiceId !== null && cfg.pagerdutyServices.includes(t.pagerdutyServiceId)
          );
        }
        return t.tags.some((tag) => tags.has(tag.trim().toLowerCase()));
      })
      .map((t) => ({
        source: t.source,
        itemId: t.itemId,
        title: t.title,
        openedAtMs: t.openedAtMs as number,
        stillOpen: openAt(t, win.toMs, atNow) === "open",
      }));
    if (items.length > 0) out.push({ deployment: d, items });
  }
  return out;
}

function readDue(
  db: Database,
  win: HandoffWindow,
  zone: string,
): { due: HandoffDueItem[]; snapshotRows: number } {
  const out: HandoffDueItem[] = [];
  let snapshotRows = 0;
  for (const service of ["jira", "linear", "github"] as const) {
    const members = listWorkSnapshot(db, service, "assigned");
    snapshotRows += members.length;
    for (const m of members) {
      const row = db.query("SELECT title, url, metadata FROM item WHERE id = ?").get(m.itemId) as {
        title: string;
        url: string | null;
        metadata: string | null;
      } | null;
      if (row === null) continue;
      const meta = record(row.metadata);
      const dueAt = meta === null ? null : num(meta, "due_at_ms");
      if (dueAt === null) continue;
      const dueMs = dueInstant(service, dueAt, zone);
      if (dueMs > win.toMs + HANDOFF_DUE_HORIZON_MS) continue;
      out.push({
        service,
        itemId: m.itemId,
        title: row.title,
        url: row.url,
        dueMs,
        overdue: dueMs <= win.toMs,
      });
    }
  }
  out.sort((a, b) => a.dueMs - b.dueMs || codeUnitCompare(a.itemId, b.itemId));
  return { due: out, snapshotRows };
}

function lastSync(db: Database, connectorId: string): number | null {
  const row = db
    .query("SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1")
    .get(connectorId) as { last_sync_at: number | null } | null;
  const at = row?.last_sync_at ?? null;
  return at === null || !Number.isFinite(at) ? null : at;
}

function readShiftSection(
  opts: OncallHandoffOptions,
  db: Database,
  configs: readonly HandoffServiceBinding[],
  term: string | undefined,
): { section: HandoffShiftSection; hasRows: boolean } {
  const r = queryOncallNow(db, {
    nowMs: opts.nowMs,
    ownFirst: true,
    serviceConfigs: configs.map((c) => ({
      serviceId: c.serviceId,
      pagerdutyServices: c.pagerdutyServices,
    })),
    ...(term === undefined ? {} : { term }),
  });
  const all = r.shifts.map(toShift);
  return {
    hasRows: r.status !== "no_data",
    section: {
      status: r.status,
      mine: all.filter((s) => s.isMe),
      onCallNow: all.slice(0, HANDOFF_SHIFT_CAP),
      next: r.next.map(toShift).slice(0, HANDOFF_SHIFT_CAP),
      sources: r.sources,
    },
  };
}

export function queryOncallHandoff(db: Database, opts: OncallHandoffOptions): OncallHandoffResult {
  const configs = opts.serviceConfigs ?? [];
  const zone = opts.zone ?? gatewayZone();
  const scope = resolveScope(opts.service, configs);
  const { section: shift, hasRows } = readShiftSection(opts, db, configs, opts.service);
  // A service the shift lookup could not match must not hide the owner's own shift: look again without it.
  const wholeShift =
    opts.service === undefined || shift.status !== "no_match"
      ? shift
      : readShiftSection(opts, db, configs, undefined).section;
  const window = resolveWindow(opts, wholeShift.mine, hasRows);

  const gaps: HandoffGap[] = [];
  if (scope === "no_match") {
    return {
      status: "no_match",
      asOfMs: opts.nowMs,
      window,
      service: opts.service ?? null,
      known: configs
        .map((c) => c.serviceId)
        .sort(codeUnitCompare)
        .slice(0, HANDOFF_KNOWN_CAP),
      shift,
      events: { items: [], total: 0 },
      deployments: { items: [], total: 0 },
      stillOpen: { items: [], total: 0 },
      watch: {
        flagged: { items: [], total: 0 },
        deploysWithIncidents: { items: [], total: 0 },
        due: { items: [], total: 0 },
      },
      freshness: [],
      historyStartsMs: null,
      gaps: [],
    };
  }

  const atNow = window.toMs >= opts.nowMs - 60_000;
  const tracked = [...readTracked(db, "pagerduty"), ...readTracked(db, "jsm")];
  const byId = new Map(tracked.map((t) => [t.itemId, t]));
  const history = readHistory(db, window.fromMs);
  const { events, byItem } = buildEvents(byId, history, window, scope);

  const openStates = tracked
    .filter((t) => inScope(t, scope))
    .map((t) => ({ t, state: openAt(t, window.toMs, atNow) }));
  const stillOpen = openStates
    .filter((s) => s.state === "open")
    .map((s) => s.t)
    .sort(
      (a, b) =>
        (a.openedAtMs ?? Number.POSITIVE_INFINITY) - (b.openedAtMs ?? Number.POSITIVE_INFINITY) ||
        codeUnitCompare(a.itemId, b.itemId),
    )
    .map(
      (t): HandoffOpenItem => ({
        source: t.source,
        itemId: t.itemId,
        title: t.title,
        url: t.url,
        status: t.status,
        severity: t.severity,
        openedAtMs: t.openedAtMs,
        acknowledged: t.acknowledged,
      }),
    );
  const unknownOpen = openStates.filter((s) => s.state === "unknown").length;

  const { all: deployments, anyIndexed: anyDeployments } = readDeployments(db, window, scope);
  const flagged = watchFlags(byId, byItem, window);
  const deployHits = correlate(
    deployments,
    tracked.filter((t) => inScope(t, scope)),
    configs,
    window,
    atNow,
  );
  const { due, snapshotRows } = readDue(db, window, zone);

  const historyStartsMs = earliestHistoryMs(db, ["pagerduty", "jira"]);
  const freshness: HandoffFreshness[] = [
    { source: "pagerduty", lastSyncMs: lastSync(db, "pagerduty") },
    { source: "jira", lastSyncMs: lastSync(db, "jira") },
  ];

  gaps.push(
    ...handoffGaps({
      trackedCount: tracked.length,
      historyStartsMs,
      window,
      hasShiftRows: hasRows,
      mine: wholeShift.mine,
      anyDeployments,
      bindingCount: configs.length,
      snapshotRows,
      atNow,
      unknownOpen,
      serviceFiltered: opts.service !== undefined,
      listLengths: [events.length, stillOpen.length, deployments.length],
      listCap: HANDOFF_LIST_CAP,
    }),
  );
  return {
    status: "ok",
    asOfMs: opts.nowMs,
    window,
    service: opts.service ?? null,
    known: [],
    shift: wholeShift,
    events: capped(events),
    deployments: capped(deployments),
    stillOpen: capped(stillOpen),
    watch: {
      flagged: capped(flagged),
      deploysWithIncidents: capped(deployHits),
      due: capped(due),
    },
    freshness,
    historyStartsMs,
    gaps,
  };
}
