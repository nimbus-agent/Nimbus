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
  ageLabel,
  buildMorningBriefing,
  CAPS,
  CHAT_UNAVAILABLE_TEXT,
  timeLabel,
} from "./briefing-build.ts";
import type { BriefingBuildInput, ChatUnreadReader } from "./briefing-types.ts";

const NOW = Date.UTC(2026, 10, 12, 8, 30);
const HOUR = 3_600_000;
const ALL = ["calendar", "oncall", "incidents", "reviews", "tickets", "mail", "chat"] as const;

let db: Database;
beforeEach(() => {
  db = openMemoryIndexDatabase();
});
afterEach(() => db.close());

function input(over: Partial<BriefingBuildInput> = {}): BriefingBuildInput {
  return {
    db,
    nowMs: NOW,
    tz: "UTC",
    gatewayZone: "UTC",
    sections: ALL,
    selfPersonId: "p1",
    serviceConfigs: [],
    ...over,
  };
}

function connectAll(): void {
  for (const id of [
    "apple",
    "google_calendar",
    "outlook",
    "pagerduty",
    "github",
    "jira",
    "gmail",
    "slack",
  ]) {
    markSynced(db, id, NOW - 4 * 60_000);
  }
}

const reader =
  (over: Partial<ReturnType<ChatUnreadReader>> = {}): ChatUnreadReader =>
  () => ({
    totalThreads: 1,
    threads: [
      {
        itemId: "s1",
        channelId: "C1",
        channelName: "general",
        channelKind: "channel",
        threadKey: "t",
        latestTsMs: NOW,
        title: "Thread title",
        url: "https://slack.example/t",
        unreadMessages: 3,
      },
    ],
    channelsWithMarker: 2,
    oldestMarkerCapturedAtMs: NOW - 10 * 60_000,
    newestMarkerCapturedAtMs: NOW - 2 * 60_000,
    ...over,
  });

describe("buildMorningBriefing", () => {
  test("one block per configured section, in config order; an unconfigured section runs no query", () => {
    connectAll();
    const b = buildMorningBriefing(input({ sections: ["mail", "calendar"] }));
    expect(b.sections.map((s) => s.section)).toEqual(["mail", "calendar"]);
    expect(b.kind).toBe("briefing");
    expect(b.generatedAt).toBe(new Date(NOW).toISOString());
    // A section that was not asked for runs no query: count the SQL that touches calendar rows.
    const seen: string[] = [];
    const realQuery = db.query.bind(db);
    db.query = ((sql: string) => {
      seen.push(sql);
      return realQuery(sql);
    }) as typeof db.query;
    buildMorningBriefing(input({ sections: ["mail"] }));
    expect(seen.some((q) => q.includes("type = 'event'"))).toBe(false);
    expect(seen.some((q) => q.includes("type = 'email'"))).toBe(true);
  });

  test("is pure: Date.now is never read", () => {
    connectAll();
    const real = Date.now;
    Date.now = () => {
      throw new Error("clock read");
    };
    try {
      expect(() => buildMorningBriefing(input({ readUnreadChat: reader() }))).not.toThrow();
    } finally {
      Date.now = real;
    }
  });

  test("a fully seeded index fills every section and the counts", () => {
    connectAll();
    seedGoogleEvent(
      db,
      {
        id: "g1",
        summary: "Standup",
        start: { dateTime: "2026-11-12T09:00:00Z" },
        end: { dateTime: "2026-11-12T09:30:00Z" },
        htmlLink: "https://cal.example/g1",
        attendees: [{ self: true }, { email: "a@x" }],
      },
      "UTC",
    );
    seedOutlookEvent(
      db,
      {
        id: "o1",
        subject: "Planning",
        start: { dateTime: "2026-11-12T09:15:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-12T10:00:00.0000000", timeZone: "UTC" },
      },
      "UTC",
    );
    seedItem(db, {
      service: "pagerduty",
      type: "oncall_shift",
      externalId: "s1",
      title: "shift",
      modifiedAt: NOW,
      metadata: {
        source: "pagerduty",
        user_name: "Me",
        is_me: true,
        schedule_name: "Primary",
        start_ms: NOW - HOUR,
        end_ms: NOW + 9 * HOUR,
        fetched_at_ms: NOW - 60_000,
        service_ids: ["PSVC"],
        service_names: ["payments"],
      },
    });
    seedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "inc1",
      title: "Checkout 500s",
      url: "https://pd.example/inc1",
      modifiedAt: NOW,
      metadata: { status: "triggered", severity: "P1", opened_at_ms: NOW - HOUR },
    });
    seedItem(db, {
      service: "github",
      type: "pr",
      externalId: "o/r#1",
      title: "Fix cache",
      url: "https://github.com/o/r/pull/1",
      modifiedAt: NOW,
      metadata: { repo: "o/r", number: 1, state: "open", branch: "fix" },
    });
    setSnapshot(db, "github", "review_requested", ["o/r#1"], NOW);
    seedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "J-1",
      title: "Overdue bug",
      modifiedAt: NOW,
      metadata: { status_category: "todo", due_at_ms: Date.parse("2026-11-10") },
    });
    setSnapshot(db, "jira", "assigned", ["J-1"], NOW - 3 * 60_000);
    seedItem(db, {
      service: "gmail",
      type: "email",
      externalId: "m1",
      title: "Hello",
      modifiedAt: NOW - HOUR,
      metadata: { threadId: "T", labelIds: ["UNREAD"], from: "Ann <ann@x>" },
    });
    const b = buildMorningBriefing(input({ readUnreadChat: reader() }));
    expect(b.counts).toEqual({
      meetings: 2,
      onCallShifts: 1,
      incidents: 0,
      reviews: 1,
      ticketsDue: 1,
      unreadMail: 1,
      unreadChat: 1,
    });
    const byName = Object.fromEntries(b.sections.map((s) => [s.section, s]));
    expect(byName["calendar"]?.rows).toHaveLength(2);
    expect(byName["oncall"]?.rows).toHaveLength(1);
    expect(byName["incidents"]?.rows).toHaveLength(1);
    expect(byName["tickets"]?.rows).toHaveLength(1);
    expect(byName["chat"]?.notes.join(" ")).toContain("2 min to 10 min old");
    expect(b.gaps.find((g) => g.category === "missing_connector")).toBeUndefined();
    const fresh = Object.fromEntries(b.freshness.map((f) => [f.section, f.text]));
    expect(fresh["Mail"]).toBe("gmail 4 min ago, outlook 4 min ago");
    expect(fresh["Tickets"]).toContain("snapshot 3 min ago");
  });

  test("an unconnected source adds exactly one gap per section and a visible empty block", () => {
    seedItem(db, {
      service: "github",
      type: "pr",
      externalId: "x",
      title: "t",
      modifiedAt: 1,
      metadata: {},
    });
    const b = buildMorningBriefing(input({ sections: ["calendar", "mail", "tickets"] }));
    const gaps = b.gaps.filter((g) => g.category === "missing_connector");
    expect(gaps).toHaveLength(3);
    expect(b.sections.every((s) => s.emptyText?.includes("No source is connected"))).toBe(true);
    expect(b.freshness.find((f) => f.section === "Mail")?.text).toBe(
      "gmail not connected, outlook not connected",
    );
  });

  test("no resolvable person adds a missing_user_identity gap and lists every incident unmarked", () => {
    connectAll();
    seedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "i1",
      title: "Down",
      modifiedAt: NOW,
      metadata: { status: "triggered" },
    });
    const b = buildMorningBriefing(input({ selfPersonId: null, sections: ["incidents"] }));
    expect(b.gaps.some((g) => g.category === "missing_user_identity")).toBe(true);
    expect(b.counts.incidents).toBe(1);
    const row = b.sections[0]?.rows[0] ?? [];
    expect(row.some((p) => p.t === "text" && p.text.startsWith("Assigned to you"))).toBe(false);
  });

  test("an empty index adds one empty_index gap", () => {
    const b = buildMorningBriefing(input());
    expect(b.gaps.filter((g) => g.category === "empty_index")).toHaveLength(1);
  });

  test("the chat section: no reader is a Gaps line; a reader without markers is a gap; unconnected Slack is a gap", () => {
    connectAll();
    const none = buildMorningBriefing(input({ sections: ["chat"] }));
    expect(none.gaps.some((g) => g.detail === CHAT_UNAVAILABLE_TEXT)).toBe(true);
    expect(none.sections[0]?.emptyText).toContain("Not available yet");

    const noMarkers = buildMorningBriefing(
      input({
        sections: ["chat"],
        readUnreadChat: reader({
          totalThreads: 0,
          threads: [],
          channelsWithMarker: 0,
          oldestMarkerCapturedAtMs: null,
          newestMarkerCapturedAtMs: null,
        }),
      }),
    );
    expect(noMarkers.gaps.some((g) => g.detail.includes("No Slack read markers yet"))).toBe(true);

    db.run("DELETE FROM sync_state WHERE connector_id = 'slack'");
    const unconnected = buildMorningBriefing(
      input({ sections: ["chat"], readUnreadChat: reader() }),
    );
    expect(unconnected.gaps.some((g) => g.detail.includes("No chat source"))).toBe(true);
  });

  test("chat renders DMs, group DMs and channels; zero threads reads as none; no marker ages is fine", () => {
    connectAll();
    const thread = (kind: "dm" | "mpim" | "channel", name: string | null) => ({
      itemId: kind,
      channelId: "CID",
      channelName: name,
      channelKind: kind,
      threadKey: kind,
      latestTsMs: NOW,
      title: kind,
      url: null,
      unreadMessages: 1,
    });
    const b = buildMorningBriefing(
      input({
        sections: ["chat"],
        readUnreadChat: reader({
          totalThreads: 13,
          threads: [thread("dm", null), thread("mpim", null), thread("channel", null)],
          oldestMarkerCapturedAtMs: null,
          newestMarkerCapturedAtMs: null,
        }),
      }),
    );
    const text = JSON.stringify(b.sections[0]?.rows);
    expect(text).toContain('"DM"');
    expect(text).toContain("group DM");
    expect(text).toContain("#CID");
    expect(b.sections[0]?.notes).toEqual(["and 10 more"]);
    const empty = buildMorningBriefing(
      input({ sections: ["chat"], readUnreadChat: reader({ totalThreads: 0, threads: [] }) }),
    );
    expect(empty.sections[0]?.emptyText).toBe("No unread Slack threads.");
  });

  test("caps: the lists stop at their cap, say 'and N more', and the counts are pre-cap", () => {
    connectAll();
    for (let i = 0; i < 25; i++) {
      seedGoogleEvent(
        db,
        {
          id: `e${String(i)}`,
          summary: `Event ${String(i).padStart(2, "0")}`,
          start: { dateTime: `2026-11-12T${String(i % 24).padStart(2, "0")}:00:00Z` },
          end: { dateTime: `2026-11-12T${String(i % 24).padStart(2, "0")}:10:00Z` },
        },
        "UTC",
      );
    }
    const b = buildMorningBriefing(input({ sections: ["calendar"] }));
    expect(b.sections[0]?.rows).toHaveLength(CAPS.calendar);
    expect(b.sections[0]?.notes).toContain("and 5 more");
    expect(b.counts.meetings).toBe(25);
  });

  test("notes for unreadable, capped and no-time calendar rows; an all-day and a day-spanning label", () => {
    connectAll();
    seedItem(db, {
      service: "apple",
      type: "event",
      externalId: "old",
      title: "Old",
      modifiedAt: 1,
      metadata: {},
    });
    seedItem(db, {
      service: "apple",
      type: "event",
      externalId: "bad",
      title: "Bad",
      modifiedAt: 2,
      metadata: {},
    });
    db.run("UPDATE item SET metadata = '{x' WHERE external_id = 'bad'");
    seedGoogleEvent(
      db,
      { id: "ad", summary: "Holiday", start: { date: "2026-11-12" }, end: { date: "2026-11-13" } },
      "UTC",
    );
    seedGoogleEvent(
      db,
      {
        id: "long",
        summary: "Overnight",
        start: { dateTime: "2026-11-11T22:00:00Z" },
        end: { dateTime: "2026-11-12T02:00:00Z" },
      },
      "UTC",
    );
    seedGoogleEvent(
      db,
      {
        id: "late",
        summary: "Late",
        start: { dateTime: "2026-11-12T23:00:00Z" },
        end: { dateTime: "2026-11-13T01:00:00Z" },
      },
      "UTC",
    );
    const b = buildMorningBriefing(input({ sections: ["calendar"] }));
    const notes = b.sections[0]?.notes.join("|") ?? "";
    expect(notes).toContain("1 events have no time recorded");
    expect(notes).toContain("1 calendar rows were unreadable");
    const rows = JSON.stringify(b.sections[0]?.rows);
    expect(rows).toContain("All day ");
    expect(rows).toContain("until 02:00");
    expect(rows).toContain("from 23:00");
  });

  test("on call: a later shift today, a binding line, a stale source and the no-data gap", () => {
    connectAll();
    const shift = (id: string, meta: Record<string, unknown>) =>
      seedItem(db, {
        service: "pagerduty",
        type: "oncall_shift",
        externalId: id,
        title: id,
        modifiedAt: NOW,
        metadata: {
          source: "pagerduty",
          user_name: "Someone",
          fetched_at_ms: NOW - 3 * HOUR,
          ...meta,
        },
      });
    shift("later", {
      is_me: true,
      policy_name_unused: 1,
      escalation_policy_name: "Policy",
      start_ms: NOW + 2 * HOUR,
      end_ms: NOW + 10 * HOUR,
      service_ids: ["PSVC"],
    });
    shift("other", {
      user_name: "Bob",
      is_me: false,
      start_ms: NOW - HOUR,
      end_ms: NOW + HOUR,
      service_ids: ["PSVC"],
    });
    shift("nextweek", { is_me: true, start_ms: NOW + 3 * 24 * HOUR, service_ids: ["PSVC"] });
    const b = buildMorningBriefing(
      input({
        sections: ["oncall"],
        serviceConfigs: [{ serviceId: "payment-service", pagerdutyServices: ["PSVC"] }],
      }),
    );
    const text = JSON.stringify(b.sections[0]?.rows);
    expect(text).toContain("You are on call from 10:30");
    expect(text).toContain("payment-service: ");
    expect(text).toContain("Bob");
    expect(b.counts.onCallShifts).toBe(1);
    expect(b.sections[0]?.notes.join(" ")).toContain("pagerduty shift data is stale");

    const none = openMemoryIndexDatabase();
    try {
      const n = buildMorningBriefing(input({ db: none, sections: ["oncall"] }));
      expect(n.gaps.some((g) => g.detail.includes("No on-call schedules"))).toBe(true);
      expect(n.freshness[0]?.text).toBe("no on-call data indexed");
      expect(n.sections[0]?.emptyText).toBe("No on-call shift for you today.");
    } finally {
      none.close();
    }
  });

  test("reviews: authored PRs show CI, an empty snapshot is not 'nothing assigned'", () => {
    connectAll();
    const empty = buildMorningBriefing(input({ sections: ["reviews"] }));
    expect(empty.sections[0]?.emptyText).toContain("the snapshot is empty or has not run yet");
    expect(empty.sections[0]?.notes).toContain(
      "GitHub only: GitLab and Bitbucket reviews are not tracked.",
    );

    seedItem(db, {
      service: "github",
      type: "pr",
      externalId: "o/r#2",
      title: "Mine",
      modifiedAt: NOW,
      metadata: { repo: "o/r", number: 2, state: "open" },
    });
    seedItem(db, {
      service: "github",
      type: "pr",
      externalId: "o/r#3",
      title: "Mine too",
      modifiedAt: NOW,
      metadata: { state: "open", branch: "b", repo: "o/r" },
    });
    seedItem(db, {
      service: "github_actions",
      type: "ci_run",
      externalId: "r",
      title: "ci",
      modifiedAt: NOW,
      metadata: { repo: "o/r", branch: "b", conclusion: "failure" },
    });
    setSnapshot(db, "github", "authored_open", ["o/r#2", "o/r#3"], NOW);
    const b = buildMorningBriefing(input({ sections: ["reviews"] }));
    const text = JSON.stringify(b.sections[0]?.rows);
    expect(text).toContain("CI: ");
    expect(text).toContain("failure");
    expect(text).toContain("o/r#2");
    expect(b.sections[0]?.notes.join(" ")).toContain("1 PRs have no branch recorded");
    expect(b.counts.reviews).toBe(0);
  });

  test("tickets: github due labels, 'nothing due' when rows exist, unreadable rows", () => {
    connectAll();
    seedItem(db, {
      service: "github",
      type: "issue",
      externalId: "o/r#9",
      title: "Gh issue",
      modifiedAt: NOW,
      metadata: { state: "open", due_at_ms: NOW - HOUR },
    });
    seedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "J-2",
      title: "Later",
      modifiedAt: NOW,
      metadata: { status_category: "todo", due_at_ms: Date.parse("2026-12-01") },
    });
    seedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "J-3",
      title: "Broken",
      modifiedAt: NOW,
      metadata: {},
    });
    db.run("UPDATE item SET metadata = '{x' WHERE external_id = 'J-3'");
    setSnapshot(db, "github", "assigned", ["o/r#9"], NOW);
    setSnapshot(db, "jira", "assigned", ["J-2", "J-3"], NOW);
    const b = buildMorningBriefing(input({ sections: ["tickets"] }));
    const text = JSON.stringify(b.sections[0]?.rows);
    expect(text).toContain("Overdue: ");
    expect(text).toContain("github, due 2026-11-12 07:30");
    const notes = b.sections[0]?.notes.join("|") ?? "";
    expect(notes).toContain("1 other open assigned items");
    expect(notes).toContain("1 rows were unreadable");

    db.run("DELETE FROM work_snapshot WHERE service = 'github'");
    const r2 = buildMorningBriefing(input({ sections: ["tickets"] }));
    expect(r2.sections[0]?.rows).toHaveLength(0);
    expect(r2.sections[0]?.emptyText).toBe("Nothing assigned to you is due today or overdue.");
    db.run("DELETE FROM work_snapshot");
    const r3 = buildMorningBriefing(input({ sections: ["tickets"] }));
    expect(r3.sections[0]?.emptyText).toContain("the snapshot is empty or has not run yet");
  });

  test("mail: Outlook notes, predate tracking, unreadable rows, the cap and thread message counts", () => {
    connectAll();
    seedItem(db, {
      service: "outlook",
      type: "email",
      externalId: "a",
      title: "Out unread",
      modifiedAt: NOW - HOUR,
      metadata: { receivedDateTime: new Date(NOW - HOUR).toISOString(), is_read: false },
    });
    seedItem(db, {
      service: "outlook",
      type: "email",
      externalId: "b",
      title: "Old",
      modifiedAt: NOW - HOUR,
      metadata: { receivedDateTime: new Date(NOW - HOUR).toISOString() },
    });
    for (const [i, id] of ["g1", "g2"].entries()) {
      seedItem(db, {
        service: "gmail",
        type: "email",
        externalId: id,
        title: `G ${id}`,
        modifiedAt: NOW - (i + 1) * HOUR,
        metadata: { threadId: "T", labelIds: ["UNREAD"], from: "Ann" },
      });
    }
    seedItem(db, {
      service: "gmail",
      type: "email",
      externalId: "bad",
      title: "Bad",
      modifiedAt: NOW,
      metadata: {},
    });
    db.run("UPDATE item SET metadata = '\"UNREAD\" {' WHERE external_id = 'bad'");
    const b = buildMorningBriefing(input({ sections: ["mail"] }));
    const notes = b.sections[0]?.notes.join("|") ?? "";
    expect(notes).toContain("counted per message");
    expect(notes).toContain("1 Outlook messages predate read tracking");
    expect(notes).toContain("1 mail rows were unreadable");
    expect(JSON.stringify(b.sections[0]?.rows)).toContain("(2 messages)");
    expect(b.counts.unreadMail).toBe(2);

    const none = openMemoryIndexDatabase();
    try {
      markSynced(none, "gmail", NOW);
      const n = buildMorningBriefing(input({ db: none, sections: ["mail"] }));
      expect(n.sections[0]?.emptyText).toBe("No unread mail from the last 7 days.");
    } finally {
      none.close();
    }
  });

  test("a 23 h day and a 25 h day build without error", () => {
    for (const [now, tz] of [
      [Date.UTC(2026, 2, 29, 12), "Europe/London"],
      [Date.UTC(2026, 9, 25, 12), "Europe/London"],
    ] as const) {
      const b = buildMorningBriefing(
        input({ nowMs: now, tz, gatewayZone: tz, sections: ["calendar"] }),
      );
      expect(b.day.endMs - b.day.startMs).toBe(dayRange(now, tz).endMs - dayRange(now, tz).startMs);
    }
  });
});

describe("labels", () => {
  test("ageLabel", () => {
    expect(ageLabel(NOW, NOW - 4 * 60_000)).toBe("4 min ago");
    expect(ageLabel(NOW, NOW - 5 * HOUR)).toBe("5 h ago");
    expect(ageLabel(NOW, NOW - 72 * HOUR)).toBe("3 d ago");
    expect(ageLabel(NOW, NOW + 1000)).toBe("0 min ago");
  });

  test("timeLabel uses the zone and caches its formatter", () => {
    expect(timeLabel(Date.UTC(2026, 6, 1, 8), "Europe/London")).toBe("09:00");
    expect(timeLabel(Date.UTC(2026, 6, 1, 8), "Europe/London")).toBe("09:00");
    expect(timeLabel(Date.UTC(2026, 6, 1, 8), "UTC")).toBe("08:00");
  });
});
