import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dayRange } from "../../briefing/briefing-day.ts";
import {
  markSynced,
  seedGoogleEvent,
  seedItem,
  seedOutlookEvent,
  setSnapshot,
} from "../../testing/briefing-fixtures.ts";
import { openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import {
  CALENDAR_SCAN_CAP,
  isOpenTicket,
  selectCalendarDay,
  selectIncidents,
  selectReviews,
  selectTickets,
  selectUnreadMail,
  serviceFreshness,
  ticketDueAt,
} from "./briefing-queries.ts";

const NOW = Date.UTC(2026, 10, 12, 8, 30); // 2026-11-12 08:30 UTC
const DAY = dayRange(NOW, "UTC");
const HOUR = 3_600_000;

let db: Database;
beforeEach(() => {
  db = openMemoryIndexDatabase();
});
afterEach(() => db.close());

const gEvent = (id: string, summary: string, start: string, end: string, extra = {}) =>
  seedGoogleEvent(
    db,
    { id, summary, start: { dateTime: start }, end: { dateTime: end }, ...extra },
    "UTC",
  );

describe("selectCalendarDay", () => {
  test("keeps the day's events from each service, sorted, and drops declined and cancelled", () => {
    gEvent("a", "Standup", "2026-11-12T09:00:00Z", "2026-11-12T09:30:00Z");
    gEvent("b", "Declined", "2026-11-12T10:00:00Z", "2026-11-12T11:00:00Z", {
      attendees: [{ self: true, responseStatus: "declined" }],
    });
    gEvent("c", "Tentative", "2026-11-12T12:00:00Z", "2026-11-12T13:00:00Z", {
      status: "tentative",
    });
    gEvent("d", "Yesterday", "2026-11-11T09:00:00Z", "2026-11-11T10:00:00Z");
    seedOutlookEvent(
      db,
      {
        id: "o1",
        subject: "Outlook sync",
        start: { dateTime: "2026-11-12T08:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-12T08:45:00.0000000", timeZone: "UTC" },
        showAs: "busy",
      },
      "UTC",
    );
    seedItem(db, {
      service: "apple",
      type: "event",
      externalId: "ic1",
      title: "Cancelled",
      modifiedAt: 1,
      metadata: {
        start_ms: Date.UTC(2026, 10, 12, 8),
        end_ms: Date.UTC(2026, 10, 12, 9),
        all_day: false,
        status: "CANCELLED",
      },
    });
    const r = selectCalendarDay(db, DAY, "UTC");
    expect(r.rows.map((e) => e.title)).toEqual(["Outlook sync", "Standup", "Tentative"]);
    expect(r.rows[2]?.tentative).toBe(true);
    expect(r.total).toBe(3);
    expect(r.capped).toBe(false);
  });

  test("a midnight-spanning event shows on both days; an all-day multi-day event on each date", () => {
    gEvent("m", "Overnight", "2026-11-11T23:00:00Z", "2026-11-12T01:00:00Z");
    seedGoogleEvent(
      db,
      { id: "ad", summary: "Offsite", start: { date: "2026-11-11" }, end: { date: "2026-11-14" } },
      "UTC",
    );
    expect(selectCalendarDay(db, DAY, "UTC").rows.map((e) => e.title)).toEqual([
      "Offsite",
      "Overnight",
    ]);
    const next = dayRange(Date.UTC(2026, 10, 13, 5), "UTC");
    expect(selectCalendarDay(db, next, "UTC").rows.map((e) => e.title)).toEqual(["Offsite"]);
    const exclusiveEnd = dayRange(Date.UTC(2026, 10, 14, 5), "UTC");
    expect(selectCalendarDay(db, exclusiveEnd, "UTC").rows).toHaveLength(0);
  });

  test("a duplicate across Google and Outlook is shown once naming both; same-service ones stay", () => {
    gEvent("g1", "Design review", "2026-11-12T14:00:00Z", "2026-11-12T15:00:00Z");
    seedOutlookEvent(
      db,
      {
        id: "o1",
        subject: " design REVIEW ",
        start: { dateTime: "2026-11-12T14:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-12T15:00:00.0000000", timeZone: "UTC" },
      },
      "UTC",
    );
    gEvent("g2", "Twin", "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z");
    gEvent("g3", "Twin", "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z");
    const r = selectCalendarDay(db, DAY, "UTC");
    const review = r.rows.filter((e) => e.title.toLowerCase().includes("design"));
    expect(review).toHaveLength(1);
    expect([...(review[0]?.services ?? [])].sort()).toEqual(["google_calendar", "outlook"]);
    expect(r.rows.filter((e) => e.title === "Twin")).toHaveLength(2);
  });

  test("an overlapping pair flags the later one; all-day events never overlap", () => {
    gEvent("a", "First", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z");
    gEvent("b", "Second", "2026-11-12T09:30:00Z", "2026-11-12T10:30:00Z");
    seedGoogleEvent(
      db,
      { id: "ad", summary: "Holiday", start: { date: "2026-11-12" }, end: { date: "2026-11-13" } },
      "UTC",
    );
    const r = selectCalendarDay(db, DAY, "UTC");
    expect(r.rows.find((e) => e.title === "Second")?.overlapsTitle).toBe("First");
    expect(r.rows.find((e) => e.title === "First")?.overlapsTitle).toBeNull();
    expect(r.rows.find((e) => e.title === "Holiday")?.overlapsTitle).toBeNull();
  });

  test("rows with no time, and rows whose metadata does not parse, are counted not shown", () => {
    seedItem(db, {
      service: "apple",
      type: "event",
      externalId: "old",
      title: "Old iCloud",
      modifiedAt: 1,
      metadata: { calendar: "Home" },
    });
    seedItem(db, {
      service: "apple",
      type: "event",
      externalId: "bad",
      title: "Bad",
      modifiedAt: 2,
      metadata: {},
    });
    db.run("UPDATE item SET metadata = '{nope' WHERE external_id = 'bad'");
    db.run("UPDATE item SET metadata = NULL WHERE external_id = 'old' AND 0");
    const r = selectCalendarDay(db, DAY, "UTC");
    expect(r.rows).toHaveLength(0);
    expect(r.noTimeCount).toBe(1);
    expect(r.unreadable).toBe(1);
    expect(r.scanned).toBe(2);
  });

  test("a scan over the cap is reported", () => {
    const stmt = db.prepare(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata) VALUES (?, 'apple', 'event', ?, 't', ?, 1, '{}')",
    );
    db.transaction(() => {
      for (let i = 0; i < CALENDAR_SCAN_CAP + 5; i++) stmt.run(`i${String(i)}`, `e${String(i)}`, i);
    })();
    stmt.finalize();
    const r = selectCalendarDay(db, DAY, "UTC");
    expect(r.capped).toBe(true);
    expect(r.scanned).toBe(CALENDAR_SCAN_CAP);
  });
});

describe("selectIncidents", () => {
  const incident = (id: string, meta: Record<string, unknown>) =>
    seedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: id,
      title: `Incident ${id}`,
      modifiedAt: NOW,
      metadata: meta,
    });

  test("resolved excluded, a missing status included, case-insensitive, newest first", () => {
    incident("1", { status: "triggered", opened_at_ms: 100 });
    incident("2", { status: "Resolved", opened_at_ms: 200 });
    incident("3", { opened_at_ms: 300 });
    incident("4", { status: "acknowledged", opened_at_ms: 400 });
    const r = selectIncidents(db, null);
    expect(r.map((e) => e.incident.title)).toEqual(["Incident 4", "Incident 3", "Incident 1"]);
    expect(r.every((e) => !e.mine)).toBe(true);
  });

  test("mine come first, via the graph edge, and are not repeated", () => {
    const a = incident("1", { status: "triggered", opened_at_ms: 100 });
    incident("2", { status: "triggered", opened_at_ms: 900 });
    const entity = (id: string, type: string, ext: string) => {
      db.run(
        "INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, metadata) VALUES (?, ?, ?, 'x', '{}')",
        [id, type, ext],
      );
      return (
        db
          .query("SELECT id FROM graph_entity WHERE type = ? AND external_id = ?")
          .get(type, ext) as { id: string }
      ).id;
    };
    const pe = entity("pe", "person", "p1");
    const ie = entity("ie", "incident", a);
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, metadata, created_at) VALUES (?, ?, 'assigned', '{}', 1)",
      [pe, ie],
    );
    const r = selectIncidents(db, "p1");
    expect(r.map((e) => [e.incident.id === a, e.mine])).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});

describe("selectReviews", () => {
  const pr = (n: number, meta: Record<string, unknown>, mod = NOW) =>
    seedItem(db, {
      service: "github",
      type: "pr",
      externalId: `o/r#${String(n)}`,
      title: `PR ${String(n)}`,
      url: `https://github.com/o/r/pull/${String(n)}`,
      modifiedAt: mod,
      metadata: { repo: "o/r", number: n, ...meta },
    });

  test("review-requested and authored lists, closed PRs dropped, CI joined by repo and branch", () => {
    pr(1, { state: "open", branch: "a" }, NOW - 5);
    pr(2, { state: "closed", branch: "b" });
    pr(3, { state: "open" }, NOW - 1);
    pr(4, { state: "open", branch: "feat" });
    pr(5, { state: "merged", branch: "m" });
    setSnapshot(db, "github", "review_requested", ["o/r#1", "o/r#2", "o/r#3"], NOW);
    setSnapshot(db, "github", "authored_open", ["o/r#4", "o/r#5"], NOW);
    seedItem(db, {
      service: "github_actions",
      type: "ci_run",
      externalId: "run1",
      title: "ci",
      modifiedAt: 10,
      metadata: { repo: "o/r", branch: "feat", conclusion: "failure" },
    });
    seedItem(db, {
      service: "github_actions",
      type: "ci_run",
      externalId: "run2",
      title: "ci",
      modifiedAt: 20,
      metadata: { repo: "o/r", branch: "feat", conclusion: "success" },
    });
    seedItem(db, {
      service: "github_actions",
      type: "ci_run",
      externalId: "run3",
      title: "ci",
      modifiedAt: 30,
      metadata: { repo: "o/r" },
    });
    const r = selectReviews(db);
    expect(r.requested.map((p) => p.title)).toEqual(["PR 3", "PR 1"]);
    expect(r.authored.map((p) => [p.title, p.ci])).toEqual([["PR 4", "success"]]);
    expect(r.noBranchCount).toBe(0);
  });

  test("an authored PR with no branch shows no CI state and is counted; bad metadata counted", () => {
    pr(7, { state: "open" });
    pr(8, { state: "open", branch: "x" });
    db.run("UPDATE item SET metadata = '{bad' WHERE external_id = 'o/r#8'");
    setSnapshot(db, "github", "authored_open", ["o/r#7", "o/r#8"], NOW);
    const r = selectReviews(db);
    expect(r.authored.map((p) => [p.title, p.ci])).toEqual([["PR 7", null]]);
    expect(r.noBranchCount).toBe(1);
    expect(r.unreadable).toBe(1);
  });
});

describe("selectTickets", () => {
  const issue = (
    service: "jira" | "linear" | "github",
    id: string,
    meta: Record<string, unknown>,
  ) =>
    seedItem(db, {
      service,
      type: "issue",
      externalId: id,
      title: `Ticket ${id}`,
      modifiedAt: NOW,
      metadata: meta,
    });

  test("overdue (oldest due first), due today, and the open-without-due count", () => {
    issue("jira", "J-1", { status_category: "in_progress", due_at_ms: Date.parse("2026-11-10") });
    issue("jira", "J-2", { status_category: "todo", due_at_ms: Date.parse("2026-11-12") });
    issue("linear", "L-1", { status_category: "todo", due_at_ms: Date.parse("2026-11-09") });
    issue("linear", "L-2", { status_category: "todo" });
    issue("jira", "J-3", { status_category: "done", due_at_ms: Date.parse("2026-11-01") });
    issue("jira", "J-4", { status_category: "todo", due_at_ms: Date.parse("2026-11-20") });
    issue("github", "o/r#9", { state: "open", due_at_ms: NOW + HOUR });
    issue("github", "o/r#10", { state: "closed", due_at_ms: NOW - HOUR });
    setSnapshot(db, "jira", "assigned", ["J-1", "J-2", "J-3", "J-4"], NOW - 1000);
    setSnapshot(db, "linear", "assigned", ["L-1", "L-2"], NOW - 2000);
    setSnapshot(db, "github", "assigned", ["o/r#9", "o/r#10"], NOW - 3000);
    const r = selectTickets(db, "UTC", DAY, NOW);
    expect(r.overdue.map((t) => t.title)).toEqual(["Ticket L-1", "Ticket J-1"]);
    expect(r.today.map((t) => t.title)).toEqual(["Ticket o/r#9", "Ticket J-2"]);
    expect(r.otherOpen).toBe(2);
    expect(r.snapshots.find((s) => s.service === "jira")).toEqual({
      service: "jira",
      rows: 4,
      capturedAtMs: NOW - 1000,
    });
  });

  test("a date-only due date is judged by the end of that date in the briefing zone", () => {
    // 2026-11-12 08:30 UTC is 2026-11-12 00:30 in Los Angeles; Jira's 2026-11-12 date is due TODAY there.
    const la = "America/Los_Angeles";
    issue("jira", "J-1", { status_category: "todo", due_at_ms: Date.parse("2026-11-12") });
    issue("jira", "J-2", { status_category: "todo", due_at_ms: Date.parse("2026-11-11") });
    setSnapshot(db, "jira", "assigned", ["J-1", "J-2"], NOW);
    const r = selectTickets(db, la, dayRange(NOW, la), NOW);
    expect(r.today.map((t) => t.title)).toEqual(["Ticket J-1"]);
    expect(r.overdue.map((t) => t.title)).toEqual(["Ticket J-2"]);
  });

  test("bad metadata is counted; no snapshot rows reads as zero rows", () => {
    issue("jira", "J-1", { status_category: "todo" });
    db.run("UPDATE item SET metadata = '{bad'");
    setSnapshot(db, "jira", "assigned", ["J-1"], NOW);
    const r = selectTickets(db, "UTC", DAY, NOW);
    expect(r.unreadable).toBe(1);
    expect(r.snapshots.find((s) => s.service === "linear")).toEqual({
      service: "linear",
      rows: 0,
      capturedAtMs: null,
    });
  });

  test("isOpenTicket and ticketDueAt", () => {
    expect(isOpenTicket("jira", {})).toBe(true);
    expect(isOpenTicket("jira", { status_category: "unknown" })).toBe(true);
    expect(isOpenTicket("linear", { status_category: "canceled" })).toBe(false);
    expect(isOpenTicket("github", { state: "closed" })).toBe(false);
    expect(isOpenTicket("github", {})).toBe(true);
    expect(ticketDueAt({ due_at_ms: 5 })).toBe(5);
    expect(ticketDueAt({ due_at_ms: "5" })).toBeNull();
  });
});

describe("selectUnreadMail", () => {
  const gmail = (id: string, meta: Record<string, unknown>, mod: number, title = `Mail ${id}`) =>
    seedItem(db, {
      service: "gmail",
      type: "email",
      externalId: id,
      title,
      modifiedAt: mod,
      metadata: meta,
    });
  const outlook = (id: string, meta: Record<string, unknown>, mod: number) =>
    seedItem(db, {
      service: "outlook",
      type: "email",
      externalId: id,
      title: `Outlook ${id}`,
      modifiedAt: mod,
      metadata: meta,
    });

  test("a Gmail thread of three unread messages is one thread; read, trash and spam are out", () => {
    gmail("1", { threadId: "T", labelIds: ["UNREAD", "INBOX"], from: "A <a@x>" }, NOW - 3 * HOUR);
    gmail("2", { threadId: "T", labelIds: ["UNREAD"], from: "B <b@x>" }, NOW - 2 * HOUR);
    gmail("3", { threadId: "T", labelIds: ["UNREAD"], from: "C <c@x>" }, NOW - 5 * HOUR, "Old one");
    gmail("4", { threadId: "U", labelIds: ["INBOX"] }, NOW - HOUR);
    gmail("5", { threadId: "V", labelIds: ["UNREAD", "TRASH"] }, NOW - HOUR);
    gmail("6", { threadId: "W", labelIds: ["UNREAD", "SPAM"] }, NOW - HOUR);
    gmail("7", { labelIds: ["UNREAD"] }, NOW - 4 * HOUR);
    gmail("8", { threadId: "X" }, NOW - 4 * HOUR);
    db.run("UPDATE item SET metadata = '[\"UNREAD\"]' WHERE external_id = '8'");
    const r = selectUnreadMail(db, NOW);
    const t = r.threads.find((x) => x.messages === 3);
    expect(t?.from).toBe("B <b@x>");
    expect(t?.title).toBe("Mail 2");
    expect(r.threads).toHaveLength(2); // thread T and the message with no threadId
    expect(r.threads.map((x) => x.service)).toEqual(["gmail", "gmail"]);
  });

  test("Outlook counts per message by is_read; rows without it predate read tracking; 7-day edge", () => {
    const recv = (ms: number) => new Date(ms).toISOString();
    outlook("a", { receivedDateTime: recv(NOW - HOUR), is_read: false }, NOW - HOUR);
    outlook("b", { receivedDateTime: recv(NOW - HOUR), is_read: true }, NOW - HOUR);
    outlook("c", { receivedDateTime: recv(NOW - HOUR) }, NOW - HOUR);
    outlook(
      "d",
      { receivedDateTime: recv(NOW - 7 * 24 * HOUR - HOUR), is_read: false },
      NOW - HOUR,
    );
    outlook("e", { receivedDateTime: "not a date", is_read: false }, NOW - HOUR);
    outlook("f", { receivedDateTime: recv(NOW - 2 * HOUR), is_read: false }, NOW - HOUR);
    const r = selectUnreadMail(db, NOW);
    expect(r.threads.map((x) => x.title)).toEqual(["Outlook a", "Outlook f"]);
    expect(r.threads.every((x) => x.from === null && x.messages === 1)).toBe(true);
    expect(r.predateReadTracking).toBe(1);
  });

  test("unparseable metadata is counted; the scan is not capped here", () => {
    gmail("1", { labelIds: ["UNREAD"] }, NOW - HOUR);
    db.run("UPDATE item SET metadata = '\"UNREAD\" {bad'");
    const r = selectUnreadMail(db, NOW);
    expect(r.unreadable).toBe(1);
    expect(r.capped).toBe(false);
    expect(r.scanned).toBe(1);
  });
});

describe("serviceFreshness", () => {
  test("no row is not connected; a row with a null time is connected and never synced", () => {
    markSynced(db, "gmail", NOW - 4 * 60_000);
    markSynced(db, "outlook", null);
    expect(serviceFreshness(db, ["gmail", "outlook", "slack"])).toEqual([
      { id: "gmail", connected: true, lastSyncMs: NOW - 4 * 60_000 },
      { id: "outlook", connected: true, lastSyncMs: null },
      { id: "slack", connected: false, lastSyncMs: null },
    ]);
  });
});
