import type { Database } from "bun:sqlite";
import { eventOnDay } from "../../briefing/briefing-day.ts";
import {
  classifyDue,
  type DueClass,
  type DueService,
  dueInstant,
} from "../../briefing/briefing-due.ts";
import { codeUnitCompare } from "../../util/code-unit-compare.ts";
import type { BriefingDay } from "./briefing-types.ts";
import { selectActiveAssignedIncidents, selectAllActiveIncidents } from "./oncall-queries.ts";
import type { OncallIncident } from "./oncall-types.ts";

/**
 * The morning briefing's reads (Phase 10 MB5). Every function is synchronous, takes `db` and plain
 * parameters, and returns plain data: no clock, no I/O beyond SQLite reads, no provider request.
 *
 * Rows are selected by a cheap COLUMN predicate and their `metadata` is parsed in TypeScript with a
 * `try/catch` (SQLite's `json_extract` raises on bad JSON and its evaluation order is
 * context-dependent), so a row that does not parse is dropped and counted, never fatal. Scans are
 * capped and a hit cap is reported.
 */

export const CALENDAR_SCAN_CAP = 20_000;
const ALL_DAY_SLACK_MS = 2 * 86_400_000;
const MAIL_SCAN_CAP = 5_000;
const CI_SCAN_CAP = 5_000;
const MAIL_WINDOW_MS = 7 * 86_400_000;

type Meta = Record<string, unknown>;

function parseMeta(json: string | null): Meta | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : null;
  } catch {
    return null;
  }
}

function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOf(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// ---- calendar -----------------------------------------------------------------------------------

export type CalendarEntry = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay: boolean;
  readonly tentative: boolean;
  readonly attendeeCount: number | null;
  /** Every service that carried this meeting (a cross-service duplicate is shown once). */
  readonly services: readonly string[];
  /** The title of an earlier timed event this one overlaps, or `null`. */
  readonly overlapsTitle: string | null;
};

export type CalendarDay = {
  readonly rows: readonly CalendarEntry[];
  readonly total: number;
  readonly noTimeCount: number;
  readonly unreadable: number;
  readonly scanned: number;
  readonly capped: boolean;
};

type EventRow = {
  id: string;
  service: string;
  title: string;
  url: string | null;
  metadata: string | null;
};

function eventEntry(
  r: EventRow,
  day: BriefingDay,
  gatewayZone: string,
): CalendarEntry | "notime" | null {
  const meta = parseMeta(r.metadata);
  if (meta === null) return null;
  // lane-census: scope=event service=apple,google_calendar,outlook
  const status = (strOf(meta["status"]) ?? "").toLowerCase();
  // lane-census: scope=event service=apple,google_calendar,outlook
  const selfResponse = meta["self_response"];
  if (status === "cancelled" || selfResponse === "declined") return null;
  // lane-census: scope=event service=apple,google_calendar,outlook
  const startMs = numOf(meta["start_ms"]);
  // lane-census: scope=event service=apple,google_calendar,outlook
  const endMs = numOf(meta["end_ms"]);
  if (startMs === null || endMs === null) return "notime";
  // lane-census: scope=event service=apple,google_calendar,outlook
  const allDay = meta["all_day"] === true;
  if (!eventOnDay({ startMs, endMs, allDay }, day, gatewayZone)) return null;
  // lane-census: scope=event service=apple,google_calendar,outlook
  const attendees = numOf(meta["attendee_count"]);
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    startMs,
    endMs,
    allDay,
    tentative: status === "tentative" || selfResponse === "tentative",
    attendeeCount: attendees,
    services: [r.service],
    overlapsTitle: null,
  };
}

function foldKey(e: CalendarEntry): string {
  return `${String(e.startMs)}|${String(e.endMs)}|${e.title.trim().toLowerCase()}`;
}

/** Entries from DIFFERENT services with the same start, end and folded title are one meeting. */
function mergeAcrossServices(entries: readonly CalendarEntry[]): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  const byKey = new Map<string, number>();
  for (const e of entries) {
    const key = foldKey(e);
    const at = byKey.get(key);
    const existing = at === undefined ? undefined : out[at];
    const service = e.services[0] ?? "";
    if (at !== undefined && existing !== undefined && !existing.services.includes(service)) {
      out[at] = { ...existing, services: [...existing.services, service] };
      continue;
    }
    byKey.set(key, out.length);
    out.push(e);
  }
  return out;
}

function byStartThenId(a: CalendarEntry, b: CalendarEntry): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || codeUnitCompare(a.id, b.id);
}

/** Marks each later timed event that intersects an earlier timed one. */
function flagOverlaps(sorted: readonly CalendarEntry[]): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const e of sorted) {
    const clash = e.allDay
      ? undefined
      : out.find((o) => !o.allDay && o.startMs < e.endMs && e.startMs < o.endMs);
    out.push(clash === undefined ? e : { ...e, overlapsTitle: clash.title });
  }
  return out;
}

export function selectCalendarDay(
  db: Database,
  day: BriefingDay,
  gatewayZone: string,
): CalendarDay {
  // The day filter runs BEFORE the scan cap: `modified_at` is the event's update time, not its start,
  // so without it a pile of newer events on other days would push today's meeting out of the scan.
  // A row whose metadata does not parse, or has no numeric start and end, is kept so it is counted.
  // The window is a superset of `eventOnDay` (all-day events are compared by calendar date in the
  // gateway zone, so they get two spare days each side); `eventOnDay` still decides.
  const rows = db
    .query(
      `SELECT id, service, title, url, metadata FROM item
        WHERE type = 'event' AND service IN ('apple','google_calendar','outlook')
          AND CASE
            WHEN NOT json_valid(metadata) THEN 1
            WHEN json_type(metadata, '$.start_ms') IN ('integer','real')
             AND json_type(metadata, '$.end_ms') IN ('integer','real') THEN
              CASE WHEN json_type(metadata, '$.all_day') = 'true'
                THEN json_extract(metadata, '$.start_ms') < ?1 + ?3
                 AND json_extract(metadata, '$.end_ms') >= ?2 - ?3
                ELSE json_extract(metadata, '$.start_ms') < ?1
                 AND json_extract(metadata, '$.end_ms') >= ?2
              END
            ELSE 1
          END
        ORDER BY modified_at DESC, id LIMIT ?4`,
    )
    .all(day.endMs, day.startMs, ALL_DAY_SLACK_MS, CALENDAR_SCAN_CAP + 1) as EventRow[];
  const capped = rows.length > CALENDAR_SCAN_CAP;
  const scanned = capped ? rows.slice(0, CALENDAR_SCAN_CAP) : rows;
  const entries: CalendarEntry[] = [];
  let noTimeCount = 0;
  let unreadable = 0;
  for (const r of scanned) {
    const e = eventEntry(r, day, gatewayZone);
    if (e === "notime") noTimeCount += 1;
    else if (e === null) {
      if (parseMeta(r.metadata) === null) unreadable += 1;
    } else entries.push(e);
  }
  const merged = flagOverlaps(mergeAcrossServices(entries).sort(byStartThenId));
  return {
    rows: merged,
    total: merged.length,
    noTimeCount,
    unreadable,
    scanned: scanned.length,
    capped,
  };
}

// ---- incidents ----------------------------------------------------------------------------------

export type IncidentEntry = { readonly incident: OncallIncident; readonly mine: boolean };

/** Mine first (graph edge), then every other active incident, newest first, deduped by id. */
export function selectIncidents(db: Database, personId: string | null): IncidentEntry[] {
  const mine = personId === null ? [] : selectActiveAssignedIncidents(db, personId);
  const mineIds = new Set(mine.map((i) => i.id));
  const others = selectAllActiveIncidents(db).filter((i) => !mineIds.has(i.id));
  return [
    ...mine.map((incident) => ({ incident, mine: true })),
    ...others.map((incident) => ({ incident, mine: false })),
  ];
}

// ---- reviews ------------------------------------------------------------------------------------

export type PrEntry = {
  readonly itemId: string;
  readonly title: string;
  readonly url: string | null;
  readonly repo: string | null;
  readonly number: number | null;
  readonly branch: string | null;
  /** The newest CI conclusion for the same repo and branch, or `null` when unknown. */
  readonly ci: string | null;
};

export type ReviewsResult = {
  readonly requested: readonly PrEntry[];
  readonly authored: readonly PrEntry[];
  readonly noBranchCount: number;
  readonly unreadable: number;
};

type PrRow = {
  id: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

function ciConclusions(db: Database): Map<string, string> {
  const rows = db
    .query(`SELECT metadata FROM item WHERE type = 'ci_run' ORDER BY modified_at DESC, id LIMIT ?`)
    .all(CI_SCAN_CAP) as Array<{ metadata: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const meta = parseMeta(r.metadata);
    if (meta === null) continue;
    // lane-census: scope=ci_run
    const repo = strOf(meta["repo"]);
    // lane-census: scope=ci_run
    const branch = strOf(meta["branch"]);
    // lane-census: scope=ci_run
    const conclusion = strOf(meta["conclusion"]);
    if (repo === null || branch === null || conclusion === null) continue;
    const key = `${repo}\u0000${branch}`;
    if (!out.has(key)) out.set(key, conclusion);
  }
  return out;
}

function listOpenPrs(
  db: Database,
  relation: "review_requested" | "authored_open",
  ci: ReadonlyMap<string, string> | null,
  acc: { unreadable: number; noBranch: number },
): PrEntry[] {
  const rows = db
    .query(
      `SELECT i.id, i.title, i.url, i.modified_at, i.metadata
         FROM work_snapshot w JOIN item i ON i.id = w.item_id
        WHERE w.service = 'github' AND w.relation = ? AND i.type = 'pr'
        ORDER BY i.modified_at DESC, i.id`,
    )
    .all(relation) as PrRow[];
  const out: PrEntry[] = [];
  for (const r of rows) {
    const meta = parseMeta(r.metadata);
    if (meta === null) {
      acc.unreadable += 1;
      continue;
    }
    // lane-census: scope=pr service=github
    const state = strOf(meta["state"]);
    if (state === "merged" || state === "closed") continue;
    // lane-census: scope=pr service=github
    const repo = strOf(meta["repo"]);
    // lane-census: scope=pr service=github
    const branch = strOf(meta["branch"]);
    // lane-census: scope=pr service=github
    const number = numOf(meta["number"]);
    let conclusion: string | null = null;
    if (ci !== null) {
      if (repo !== null && branch !== null) conclusion = ci.get(`${repo}\u0000${branch}`) ?? null;
      else acc.noBranch += 1;
    }
    out.push({ itemId: r.id, title: r.title, url: r.url, repo, number, branch, ci: conclusion });
  }
  return out;
}

export function selectReviews(db: Database): ReviewsResult {
  const acc = { unreadable: 0, noBranch: 0 };
  const requested = listOpenPrs(db, "review_requested", null, acc);
  const authored = listOpenPrs(db, "authored_open", ciConclusions(db), acc);
  return { requested, authored, noBranchCount: acc.noBranch, unreadable: acc.unreadable };
}

// ---- tickets ------------------------------------------------------------------------------------

const TICKET_SERVICES: readonly DueService[] = ["jira", "linear", "github"];

/**
 * Whether an assigned item is still open. A Jira or Linear item is open unless its category is
 * `done` or `canceled` (a missing or `unknown` category counts as open: fail toward showing); a
 * GitHub issue is open unless it reads `closed`.
 */
export function isOpenTicket(service: DueService, meta: Meta): boolean {
  if (service === "github") {
    // lane-census: scope=issue service=github
    return strOf(meta["state"]) !== "closed";
  }
  // lane-census: scope=issue service=jira,linear
  const category = strOf(meta["status_category"]);
  return category !== "done" && category !== "canceled";
}

/** `due_at_ms` of a ticket row, or `null`. */
export function ticketDueAt(meta: Meta): number | null {
  // lane-census: scope=issue service=jira,linear,github
  return numOf(meta["due_at_ms"]);
}

export type TicketEntry = {
  readonly itemId: string;
  readonly service: DueService;
  readonly title: string;
  readonly url: string | null;
  readonly dueInstantMs: number;
  readonly due: Exclude<DueClass, "later">;
};

export type TicketsResult = {
  readonly overdue: readonly TicketEntry[];
  readonly today: readonly TicketEntry[];
  readonly otherOpen: number;
  readonly unreadable: number;
  /** Per service: how many snapshot rows exist and the newest `captured_at` among them. */
  readonly snapshots: ReadonlyArray<{
    readonly service: DueService;
    readonly rows: number;
    readonly capturedAtMs: number | null;
  }>;
};

type TicketRow = {
  id: string;
  service: string;
  title: string;
  url: string | null;
  metadata: string | null;
  captured_at: number;
};

function byDueThenId(a: TicketEntry, b: TicketEntry): number {
  return a.dueInstantMs - b.dueInstantMs || codeUnitCompare(a.itemId, b.itemId);
}

export function selectTickets(
  db: Database,
  tz: string,
  day: BriefingDay,
  nowMs: number,
): TicketsResult {
  const rows = db
    .query(
      `SELECT i.id, i.service, i.title, i.url, i.metadata, w.captured_at
         FROM work_snapshot w JOIN item i ON i.id = w.item_id
        WHERE w.relation = 'assigned' AND w.service IN ('jira','linear','github')
          AND i.type = 'issue'`,
    )
    .all() as TicketRow[];
  const overdue: TicketEntry[] = [];
  const today: TicketEntry[] = [];
  let otherOpen = 0;
  let unreadable = 0;
  const snap = new Map<DueService, { rows: number; capturedAtMs: number | null }>(
    TICKET_SERVICES.map((s) => [s, { rows: 0, capturedAtMs: null }]),
  );
  for (const r of rows) {
    const service = r.service as DueService;
    const s = snap.get(service);
    if (s !== undefined) {
      s.rows += 1;
      s.capturedAtMs = Math.max(s.capturedAtMs ?? 0, r.captured_at);
    }
    const meta = parseMeta(r.metadata);
    if (meta === null) {
      unreadable += 1;
      continue;
    }
    if (!isOpenTicket(service, meta)) continue;
    const dueAt = ticketDueAt(meta);
    const due =
      dueAt === null ? "later" : classifyDue(dueInstant(service, dueAt, tz), nowMs, day.endMs);
    if (dueAt === null || due === "later") {
      otherOpen += 1;
      continue;
    }
    const entry: TicketEntry = {
      itemId: r.id,
      service,
      title: r.title,
      url: r.url,
      dueInstantMs: dueInstant(service, dueAt, tz),
      due,
    };
    (due === "overdue" ? overdue : today).push(entry);
  }
  return {
    overdue: overdue.sort(byDueThenId),
    today: today.sort(byDueThenId),
    otherOpen,
    unreadable,
    snapshots: TICKET_SERVICES.map((service) => ({
      service,
      rows: snap.get(service)?.rows ?? 0,
      capturedAtMs: snap.get(service)?.capturedAtMs ?? null,
    })),
  };
}

// ---- mail ---------------------------------------------------------------------------------------

export type MailThread = {
  readonly service: "gmail" | "outlook";
  readonly title: string;
  readonly url: string | null;
  /** The raw `From` header (Gmail only; the Outlook writer records no sender). */
  readonly from: string | null;
  readonly messages: number;
  readonly latestMs: number;
};

export type MailResult = {
  readonly threads: readonly MailThread[];
  /** Outlook rows whose `is_read` was never recorded: they cannot be classed as unread. */
  readonly predateReadTracking: number;
  readonly unreadable: number;
  readonly scanned: number;
  readonly capped: boolean;
};

type MailRow = {
  id: string;
  service: "gmail" | "outlook";
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

type MailAcc = {
  gmail: Map<string, MailThread>;
  outlook: MailThread[];
  predate: number;
  unreadable: number;
};

function addGmail(acc: MailAcc, r: MailRow, meta: Meta): void {
  // lane-census: scope=email service=gmail
  const labels = meta["labelIds"];
  if (!Array.isArray(labels) || !labels.includes("UNREAD")) return;
  if (labels.includes("TRASH") || labels.includes("SPAM")) return;
  // lane-census: scope=email service=gmail
  const threadKey = strOf(meta["threadId"]) ?? r.id;
  // lane-census: scope=email service=gmail
  const from = strOf(meta["from"]);
  const prev = acc.gmail.get(threadKey);
  if (prev === undefined) {
    acc.gmail.set(threadKey, {
      service: "gmail",
      title: r.title,
      url: r.url,
      from,
      messages: 1,
      latestMs: r.modified_at,
    });
    return;
  }
  const newer = r.modified_at > prev.latestMs;
  acc.gmail.set(threadKey, {
    ...prev,
    messages: prev.messages + 1,
    ...(newer ? { title: r.title, url: r.url, from, latestMs: r.modified_at } : {}),
  });
}

function addOutlook(acc: MailAcc, r: MailRow, meta: Meta, sinceMs: number): void {
  // lane-census: scope=email service=outlook
  const isRead = meta["is_read"];
  if (typeof isRead !== "boolean") {
    acc.predate += 1;
    return;
  }
  if (isRead) return;
  // lane-census: scope=email service=outlook
  const received = strOf(meta["receivedDateTime"]);
  const receivedMs = received === null ? Number.NaN : Date.parse(received);
  if (!Number.isFinite(receivedMs) || receivedMs < sinceMs) return;
  acc.outlook.push({
    service: "outlook",
    title: r.title,
    url: r.url,
    from: null,
    messages: 1,
    latestMs: receivedMs,
  });
}

export function selectUnreadMail(db: Database, nowMs: number): MailResult {
  const sinceMs = nowMs - MAIL_WINDOW_MS;
  const rows = db
    .query(
      `SELECT id, service, title, url, modified_at, metadata FROM item
        WHERE type = 'email' AND service IN ('gmail','outlook') AND modified_at >= ?
          AND (service = 'outlook' OR instr(metadata, '"UNREAD"') > 0)
        ORDER BY modified_at DESC, id LIMIT ?`,
    )
    .all(sinceMs, MAIL_SCAN_CAP + 1) as MailRow[];
  const capped = rows.length > MAIL_SCAN_CAP;
  const scanned = capped ? rows.slice(0, MAIL_SCAN_CAP) : rows;
  const acc: MailAcc = { gmail: new Map(), outlook: [], predate: 0, unreadable: 0 };
  for (const r of scanned) {
    const meta = parseMeta(r.metadata);
    if (meta === null) acc.unreadable += 1;
    else if (r.service === "gmail") addGmail(acc, r, meta);
    else addOutlook(acc, r, meta, sinceMs);
  }
  const threads = [...acc.gmail.values(), ...acc.outlook].sort(
    (a, b) => b.latestMs - a.latestMs || codeUnitCompare(a.title, b.title),
  );
  return {
    threads,
    predateReadTracking: acc.predate,
    unreadable: acc.unreadable,
    scanned: scanned.length,
    capped,
  };
}

// ---- sources and freshness ----------------------------------------------------------------------

/** The connector ids each section reads (a section is "connected" when any one has a `sync_state` row). */
export const SECTION_SERVICES = {
  calendar: ["apple", "google_calendar", "outlook"],
  oncall: ["pagerduty"],
  incidents: ["pagerduty"],
  reviews: ["github"],
  tickets: ["jira", "linear", "github"],
  mail: ["gmail", "outlook"],
  chat: ["slack"],
} as const;

export type ServiceFreshness = {
  readonly id: string;
  readonly connected: boolean;
  readonly lastSyncMs: number | null;
};

/** A service is "connected" when it has a `sync_state` row; `lastSyncMs` is its `last_sync_at`. */
export function serviceFreshness(db: Database, ids: readonly string[]): ServiceFreshness[] {
  const out: ServiceFreshness[] = [];
  const q = db.query("SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1");
  for (const id of ids) {
    const row = q.get(id) as { last_sync_at: number | null } | null;
    out.push({ id, connected: row !== null, lastSyncMs: row?.last_sync_at ?? null });
  }
  return out;
}
