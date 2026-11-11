import type { GapNote } from "@nimbus-dev/sdk";

import { dateKeyInZone, dayRange } from "../../briefing/briefing-day.ts";
import { type OncallShiftView, queryOncallNow } from "../../index/oncall-now-query.ts";
import {
  type CalendarEntry,
  type ServiceFreshness,
  selectCalendarDay,
  selectIncidents,
  selectReviews,
  selectTickets,
  SECTION_SERVICES,
  selectUnreadMail,
  serviceFreshness,
  type TicketEntry,
} from "./briefing-queries.ts";
import type {
  BriefingBrief,
  BriefingBuildInput,
  BriefingCounts,
  BriefingDay,
  BriefingRow,
  BriefingSectionBlock,
  ChatUnreadThread,
  FreshnessRow,
} from "./briefing-types.ts";
import { detectEmptyIndex } from "./gap-notes.ts";

/**
 * Builds the morning briefing (Phase 10 MB5). A pure function of the database and the clock it is
 * handed: no `Date.now`, no ambient zone, no I/O beyond SQLite reads. A section that is not in
 * `input.sections` runs no query. Counts are PRE-cap totals; the rendered lists carry the caps.
 */

export const CAPS = {
  calendar: 20,
  oncall: 10,
  incidents: 10,
  requested: 15,
  authored: 10,
  tickets: 25,
  mail: 10,
  chat: 10,
} as const;

export const CHAT_UNAVAILABLE_TEXT =
  "Unread Slack threads are not available yet: Slack read markers are not indexed in this version.";

const EMPTY_COUNTS: BriefingCounts = {
  meetings: 0,
  onCallShifts: 0,
  incidents: 0,
  reviews: 0,
  ticketsDue: 0,
  unreadMail: 0,
  unreadChat: 0,
};

const MIN = 60_000;
const HOUR = 3_600_000;

/** "4 min ago", "3 h ago", "2 d ago". */
export function ageLabel(nowMs: number, thenMs: number): string {
  const age = Math.max(0, nowMs - thenMs);
  if (age < HOUR) return `${String(Math.floor(age / MIN))} min ago`;
  if (age < 48 * HOUR) return `${String(Math.floor(age / HOUR))} h ago`;
  return `${String(Math.floor(age / (24 * HOUR)))} d ago`;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** `HH:mm` of an instant in `tz`. */
export function timeLabel(ms: number, tz: string): string {
  let f = timeFormatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeFormatters.set(tz, f);
  }
  return f.format(new Date(ms));
}

type Ctx = {
  readonly input: BriefingBuildInput;
  readonly day: BriefingDay;
  readonly gaps: GapNote[];
  readonly freshness: FreshnessRow[];
};

type SectionOut = {
  readonly block: BriefingSectionBlock;
  readonly counts: Partial<BriefingCounts>;
};

const txt = (text: string) => ({ t: "text", text }) as const;
const plain = (text: string) => ({ t: "plain", text }) as const;
const link = (title: string, url: string | null) => ({ t: "link", title, url }) as const;

function moreNote(total: number, shown: number): string[] {
  return total > shown ? [`and ${String(total - shown)} more`] : [];
}

function addGap(ctx: Ctx, category: GapNote["category"], detail: string, remediation?: string) {
  ctx.gaps.push(
    remediation === undefined ? { category, detail } : { category, detail, remediation },
  );
}

function freshnessText(nowMs: number, rows: readonly ServiceFreshness[]): string {
  return rows
    .map((r) => {
      if (!r.connected) return `${r.id} not connected`;
      return r.lastSyncMs === null
        ? `${r.id} never synced`
        : `${r.id} ${ageLabel(nowMs, r.lastSyncMs)}`;
    })
    .join(", ");
}

/** Reads each service's sync state, records the freshness row, and reports whether any is connected. */
function sourceCheck(ctx: Ctx, section: string, ids: readonly string[]): boolean {
  const rows = serviceFreshness(ctx.input.db, ids);
  ctx.freshness.push({ section, text: freshnessText(ctx.input.nowMs, rows) });
  const connected = rows.some((r) => r.connected);
  if (!connected) {
    addGap(
      ctx,
      "missing_connector",
      `No ${section.toLowerCase()} source is connected (${ids.join(", ")}).`,
      `Run \`nimbus connector auth ${ids[0] ?? ""}\` to register and sync.`,
    );
  }
  return connected;
}

function notConnected(section: BriefingSectionBlock["section"], title: string): SectionOut {
  return {
    block: {
      section,
      title,
      rows: [],
      notes: [],
      emptyText: "No source is connected for this section (see Gaps).",
    },
    counts: {},
  };
}

// ---- calendar ----------------------------------------------------------------------------------

function calendarRow(e: CalendarEntry, ctx: Ctx): BriefingRow {
  const { tz } = ctx.input;
  const { day } = ctx;
  let when = "All day";
  if (!e.allDay) {
    if (e.startMs < day.startMs) when = `until ${timeLabel(e.endMs, tz)}`;
    else if (e.endMs > day.endMs) when = `from ${timeLabel(e.startMs, tz)}`;
    else when = `${timeLabel(e.startMs, tz)}-${timeLabel(e.endMs, tz)}`;
  }
  const parts: BriefingRow[number][] = [txt(`${when} `), link(e.title, e.url)];
  const extra: string[] = [];
  if (e.tentative) extra.push("tentative");
  if (e.attendeeCount !== null && e.attendeeCount > 0)
    extra.push(`${String(e.attendeeCount)} attendees`);
  if (e.services.length > 1) extra.push(`in ${e.services.join(" and ")}`);
  if (extra.length > 0) parts.push(txt(` (${extra.join(", ")})`));
  if (e.overlapsTitle !== null) {
    parts.push(txt(" - overlaps with "), plain(e.overlapsTitle));
  }
  return parts;
}

function calendarSection(ctx: Ctx): SectionOut {
  if (!sourceCheck(ctx, "Calendar", SECTION_SERVICES.calendar)) {
    return notConnected("calendar", "Calendar");
  }
  const r = selectCalendarDay(ctx.input.db, ctx.day, ctx.input.gatewayZone);
  const notes = [...moreNote(r.total, CAPS.calendar)];
  if (r.noTimeCount > 0) {
    notes.push(`${String(r.noTimeCount)} events have no time recorded and are not shown`);
  }
  if (r.unreadable > 0) notes.push(`${String(r.unreadable)} calendar rows were unreadable`);
  if (r.capped) notes.push("the scan stopped at 20,000 calendar rows");
  return {
    block: {
      section: "calendar",
      title: "Calendar",
      rows: r.rows.slice(0, CAPS.calendar).map((e) => calendarRow(e, ctx)),
      notes,
      emptyText: r.total === 0 ? "No meetings today." : null,
    },
    counts: { meetings: r.total },
  };
}

// ---- on call -----------------------------------------------------------------------------------

function shiftEnd(s: OncallShiftView, tz: string): string {
  return s.endMs === null ? "" : ` until ${timeLabel(s.endMs, tz)}`;
}

function shiftRow(s: OncallShiftView, lead: string, tz: string): BriefingRow {
  const where = s.scheduleName ?? s.policyName;
  const parts: BriefingRow[number][] = [txt(lead)];
  if (where !== null) parts.push(plain(where));
  parts.push(txt(` (${s.source})${shiftEnd(s, tz)}`));
  return parts;
}

function oncallSection(ctx: Ctx): SectionOut {
  const { db, nowMs, tz, serviceConfigs } = ctx.input;
  const res = queryOncallNow(db, { nowMs, serviceConfigs });
  const mine = res.shifts.filter((s) => s.isMe);
  const later = res.next.filter(
    (s): s is OncallShiftView & { startMs: number } =>
      s.isMe && s.startMs !== null && s.startMs < ctx.day.endMs,
  );
  const rows: BriefingRow[] = [
    ...mine.map((s) => shiftRow(s, "You are on call: ", tz)),
    ...later.map((s) => shiftRow(s, `You are on call from ${timeLabel(s.startMs, tz)}: `, tz)),
  ];
  for (const b of serviceConfigs) {
    const bound = queryOncallNow(db, { nowMs, term: b.serviceId, serviceConfigs });
    for (const s of bound.shifts.slice(0, 2)) {
      rows.push([txt(`${b.serviceId}: `), plain(s.userName), txt(` is on call${shiftEnd(s, tz)}`)]);
    }
  }
  const notes: string[] = [...moreNote(rows.length, CAPS.oncall)];
  if (res.status === "no_data") {
    addGap(
      ctx,
      "missing_connector",
      "No on-call schedules are indexed yet.",
      "Run `nimbus connector auth pagerduty`.",
    );
  }
  for (const s of res.sources) {
    if (s.stale) notes.push(`${s.source} shift data is stale`);
  }
  ctx.freshness.push({
    section: "On call",
    text:
      res.sources
        .map(
          (s) =>
            `${s.source} ${s.oldestFetchedMs === null ? "age unknown" : ageLabel(nowMs, s.oldestFetchedMs)}`,
        )
        .join(", ") || "no on-call data indexed",
  });
  return {
    block: {
      section: "oncall",
      title: "On call",
      rows: rows.slice(0, CAPS.oncall),
      notes,
      emptyText: rows.length === 0 ? "No on-call shift for you today." : null,
    },
    counts: { onCallShifts: mine.length + later.length },
  };
}

// ---- incidents ---------------------------------------------------------------------------------

function incidentsSection(ctx: Ctx): SectionOut {
  if (!sourceCheck(ctx, "Incidents", SECTION_SERVICES.incidents)) return notConnected("incidents", "Incidents");
  const { selfPersonId } = ctx.input;
  const all = selectIncidents(ctx.input.db, selfPersonId);
  const rows: BriefingRow[] = all.slice(0, CAPS.incidents).map(({ incident: i, mine }) => {
    const parts: BriefingRow[number][] = [
      txt(mine ? "Assigned to you: " : ""),
      link(i.title, i.url),
    ];
    parts.push(txt(" - "), plain(i.status ?? "status unknown"));
    if (i.severity !== null) parts.push(txt(" "), plain(i.severity));
    return parts;
  });
  const mineCount = all.filter((e) => e.mine).length;
  return {
    block: {
      section: "incidents",
      title: "Incidents",
      rows,
      notes: moreNote(all.length, CAPS.incidents),
      emptyText: all.length === 0 ? "No active incidents." : null,
    },
    counts: { incidents: selfPersonId === null ? all.length : mineCount },
  };
}

// ---- reviews -----------------------------------------------------------------------------------

function prWhere(repo: string | null, number: number | null): BriefingRow[number][] {
  if (repo === null) return [];
  return [txt(" - "), plain(number === null ? repo : `${repo}#${String(number)}`)];
}

function reviewsSection(ctx: Ctx): SectionOut {
  if (!sourceCheck(ctx, "Reviews", SECTION_SERVICES.reviews)) return notConnected("reviews", "Reviews");
  const r = selectReviews(ctx.input.db);
  const rows: BriefingRow[] = [
    ...r.requested
      .slice(0, CAPS.requested)
      .map(
        (p): BriefingRow => [
          txt("Review requested: "),
          link(p.title, p.url),
          ...prWhere(p.repo, p.number),
        ],
      ),
    ...r.authored.slice(0, CAPS.authored).map((p): BriefingRow => {
      const ci = p.ci === null ? [] : [txt(" - CI: "), plain(p.ci)];
      return [txt("Your PR: "), link(p.title, p.url), ...prWhere(p.repo, p.number), ...ci];
    }),
  ];
  const notes = [
    ...moreNote(r.requested.length, CAPS.requested).map((n) => `${n} review requests`),
    ...moreNote(r.authored.length, CAPS.authored).map((n) => `${n} of your pull requests`),
  ];
  if (r.noBranchCount > 0) notes.push(`${String(r.noBranchCount)} PRs have no branch recorded`);
  if (r.unreadable > 0) notes.push(`${String(r.unreadable)} rows were unreadable`);
  notes.push("GitHub only: GitLab and Bitbucket reviews are not tracked.");
  const none = r.requested.length === 0 && r.authored.length === 0;
  return {
    block: {
      section: "reviews",
      title: "Reviews",
      rows,
      notes,
      emptyText: none
        ? "No open review requests or authored pull requests are indexed (the snapshot is empty or has not run yet)."
        : null,
    },
    counts: { reviews: r.requested.length },
  };
}

// ---- tickets -----------------------------------------------------------------------------------

function dueLabel(t: TicketEntry, tz: string): string {
  if (t.service === "github") {
    return `${dateKeyInZone(t.dueInstantMs, tz) ?? ""} ${timeLabel(t.dueInstantMs, tz)}`.trim();
  }
  return dateKeyInZone(t.dueInstantMs - 1, tz) ?? "";
}

function ticketRow(t: TicketEntry, ctx: Ctx): BriefingRow {
  const lead = t.due === "overdue" ? "Overdue: " : "Due today: ";
  return [
    txt(lead),
    link(t.title, t.url),
    txt(` - ${t.service}, due ${dueLabel(t, ctx.input.tz)}`),
  ];
}

function ticketsSection(ctx: Ctx): SectionOut {
  const fresh = serviceFreshness(ctx.input.db, SECTION_SERVICES.tickets);
  const connected = fresh.some((f) => f.connected);
  const text = freshnessText(ctx.input.nowMs, fresh);
  if (!connected) {
    ctx.freshness.push({ section: "Tickets", text });
    addGap(
      ctx,
      "missing_connector",
      "No ticket source is connected (jira, linear, github).",
      "Run `nimbus connector auth jira`.",
    );
    return notConnected("tickets", "Tickets");
  }
  const r = selectTickets(ctx.input.db, ctx.input.tz, ctx.day, ctx.input.nowMs);
  const newest = r.snapshots.reduce<number | null>(
    (m, s) => (s.capturedAtMs === null ? m : Math.max(m ?? 0, s.capturedAtMs)),
    null,
  );
  ctx.freshness.push({
    section: "Tickets",
    text: newest === null ? text : `${text}; snapshot ${ageLabel(ctx.input.nowMs, newest)}`,
  });
  const due = [...r.overdue, ...r.today];
  const notes = [...moreNote(due.length, CAPS.tickets)];
  if (r.otherOpen > 0)
    notes.push(
      `${String(r.otherOpen)} other open assigned items have no due date or are due later`,
    );
  if (r.unreadable > 0) notes.push(`${String(r.unreadable)} rows were unreadable`);
  const anyRows = r.snapshots.some((s) => s.rows > 0);
  let emptyText: string | null = null;
  if (due.length === 0) {
    emptyText = anyRows
      ? "Nothing assigned to you is due today or overdue."
      : "No open assigned items are indexed (the snapshot is empty or has not run yet).";
  }
  return {
    block: {
      section: "tickets",
      title: "Tickets",
      rows: due.slice(0, CAPS.tickets).map((t) => ticketRow(t, ctx)),
      notes,
      emptyText,
    },
    counts: { ticketsDue: due.length },
  };
}

// ---- mail --------------------------------------------------------------------------------------

function mailSection(ctx: Ctx): SectionOut {
  if (!sourceCheck(ctx, "Mail", SECTION_SERVICES.mail)) return notConnected("mail", "Mail");
  const r = selectUnreadMail(ctx.input.db, ctx.input.nowMs);
  const rows: BriefingRow[] = r.threads.slice(0, CAPS.mail).map((m) => {
    const parts: BriefingRow[number][] = [link(m.title, m.url)];
    if (m.from !== null) parts.push(txt(" - from "), plain(m.from));
    if (m.messages > 1) parts.push(txt(` (${String(m.messages)} messages)`));
    return parts;
  });
  const notes = [...moreNote(r.threads.length, CAPS.mail)];
  if (r.threads.some((m) => m.service === "outlook")) {
    notes.push("Outlook mail is counted per message, not per thread.");
  }
  if (r.predateReadTracking > 0) {
    notes.push(
      `${String(r.predateReadTracking)} Outlook messages predate read tracking and are not counted`,
    );
  }
  if (r.unreadable > 0) notes.push(`${String(r.unreadable)} mail rows were unreadable`);
  if (r.capped) notes.push("the scan stopped at 5,000 mail rows");
  return {
    block: {
      section: "mail",
      title: "Mail",
      rows,
      notes,
      emptyText: r.threads.length === 0 ? "No unread mail from the last 7 days." : null,
    },
    counts: { unreadMail: r.threads.length },
  };
}

// ---- chat (the MB4 seam) ------------------------------------------------------------------------

function chatEmpty(text: string): SectionOut {
  return {
    block: { section: "chat", title: "Chat", rows: [], notes: [], emptyText: text },
    counts: {},
  };
}

function chatWhere(t: ChatUnreadThread): string {
  if (t.channelKind === "channel") return `#${t.channelName ?? t.channelId}`;
  return t.channelKind === "dm" ? "DM" : "group DM";
}

function chatSection(ctx: Ctx): SectionOut {
  const reader = ctx.input.readUnreadChat;
  if (reader === undefined) {
    addGap(ctx, "missing_connector", CHAT_UNAVAILABLE_TEXT);
    return chatEmpty("Not available yet (see Gaps).");
  }
  if (!sourceCheck(ctx, "Chat", SECTION_SERVICES.chat)) return notConnected("chat", "Chat");
  const r = reader(ctx.input.db, { nowMs: ctx.input.nowMs, limit: CAPS.chat });
  if (r.channelsWithMarker === 0) {
    addGap(
      ctx,
      "missing_connector",
      "No Slack read markers yet (the next Slack sync records them).",
    );
    return chatEmpty("Not available yet (see Gaps).");
  }
  const rows: BriefingRow[] = r.threads.slice(0, CAPS.chat).map((t) => {
    const where = chatWhere(t);
    return [
      link(t.title, t.url),
      txt(" - "),
      plain(where),
      txt(` (${String(t.unreadMessages)} unread)`),
    ];
  });
  const notes = [...moreNote(r.totalThreads, Math.min(r.threads.length, CAPS.chat))];
  if (r.oldestMarkerCapturedAtMs !== null && r.newestMarkerCapturedAtMs !== null) {
    const newest = Math.floor((ctx.input.nowMs - r.newestMarkerCapturedAtMs) / MIN);
    const oldest = Math.floor((ctx.input.nowMs - r.oldestMarkerCapturedAtMs) / MIN);
    notes.push(
      `Slack read markers are ${String(Math.max(0, newest))} min to ${String(Math.max(0, oldest))} min old`,
    );
  }
  return {
    block: {
      section: "chat",
      title: "Chat",
      rows,
      notes,
      emptyText: r.totalThreads === 0 ? "No unread Slack threads." : null,
    },
    counts: { unreadChat: r.totalThreads },
  };
}

const BUILDERS: Readonly<Record<BriefingSectionBlock["section"], (ctx: Ctx) => SectionOut>> = {
  calendar: calendarSection,
  oncall: oncallSection,
  incidents: incidentsSection,
  reviews: reviewsSection,
  tickets: ticketsSection,
  mail: mailSection,
  chat: chatSection,
};

export function buildMorningBriefing(input: BriefingBuildInput): BriefingBrief {
  const day = dayRange(input.nowMs, input.tz);
  const ctx: Ctx = { input, day, gaps: [], freshness: [] };
  const blocks: BriefingSectionBlock[] = [];
  let counts = EMPTY_COUNTS;
  for (const section of input.sections) {
    const out = BUILDERS[section](ctx);
    blocks.push(out.block);
    counts = { ...counts, ...out.counts };
  }
  if (input.selfPersonId === null && input.sections.includes("incidents")) {
    addGap(
      ctx,
      "missing_user_identity",
      "Could not tell which person you are, so every active incident is listed unmarked.",
      "Set `[user] mePersonId` in nimbus.toml or run `nimbus connector auth github`.",
    );
  }
  const empty = detectEmptyIndex(input.db);
  if (empty !== null) ctx.gaps.push(empty);
  return {
    kind: "briefing",
    agentVersion: 1,
    generatedAt: new Date(input.nowMs).toISOString(),
    latencyMs: 0,
    gaps: ctx.gaps,
    tz: input.tz,
    day,
    sections: blocks,
    counts,
    freshness: ctx.freshness,
  };
}
