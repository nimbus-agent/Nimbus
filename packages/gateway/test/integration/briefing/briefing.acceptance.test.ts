/**
 * Morning briefing MB5, end to end over a real SQLite FILE: `LocalIndex.ensureSchema`, the real calendar
 * mappers and the production `upsertItem` capability seeding the index, the real briefing runtime and
 * scheduler on an injected clock, recording sinks for the event and the toast, and `globalThis.fetch`
 * replaced by a thrower after seeding (every assertion below is local).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBriefingRuntime } from "../../../src/briefing/briefing-runtime.ts";
import { parseNimbusTomlBriefing } from "../../../src/config/briefing-toml.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { queryOncallNow } from "../../../src/index/oncall-now-query.ts";
import type { BriefingReadyPayload } from "../../../src/ipc/gateway-events.ts";
import { ensureFullSqlite } from "../../../src/platform/sqlite-runtime.ts";
import {
  markSynced,
  seedGoogleEvent,
  seedItem,
  seedOutlookEvent,
  setSnapshot,
} from "../../../src/testing/briefing-fixtures.ts";
import { rmDirWithRetry } from "../../helpers/rm-dir-with-retry.ts";

const HOUR = 3_600_000;
const z = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const LONDON = '[briefing]\nenabled = true\ntz = "Europe/London"\nschedule = "30 8 * * 1-5"\n';

const DEADLINES_ONLY = '[briefing]\ntz = "Europe/London"\n[briefing.deadlines]\nenabled = true\n';

const tempDirs: string[] = [];
const realFetch = globalThis.fetch;
let fetchCalls = 0;
let db: Database;
let now: number;
let events: BriefingReadyPayload[];
let toasts: Array<{ title: string; body: string }>;

function createIndexDb(): Database {
  ensureFullSqlite();
  const root = mkdtempSync(join(tmpdir(), "nimbus-briefing-acceptance-"));
  tempDirs.push(root);
  const d = new Database(join(root, "index.db"));
  LocalIndex.ensureSchema(d);
  return d;
}

beforeEach(() => {
  db = createIndexDb();
  events = [];
  toasts = [];
  fetchCalls = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  Bun.gc(true);
  for (const d of tempDirs.splice(0)) rmDirWithRetry(d);
});

function runtime(toml: string) {
  const cfg = parseNimbusTomlBriefing(toml);
  return createBriefingRuntime({
    db,
    configDir: join(tmpdir(), "nimbus-briefing-acceptance-no-config"),
    now: () => now,
    resolveSelf: async () => null,
    emit: (p) => events.push(p),
    toast: async (title, body) => {
      toasts.push({ title, body });
      return "delivered";
    },
    toastDelivers: () => true,
    demo: false,
    loadConfig: () => cfg,
  });
}

function noNetwork(): void {
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("the briefing must not touch the network");
  }) as unknown as typeof fetch;
}

/** The index of a working morning: every section has a source and at least one row. */
function seedMorning(day = { y: 2026, mo: 11, d: 12 }): void {
  const at = (h: number, mi = 0) => z(day.y, day.mo, day.d, h, mi);
  const iso = (ms: number) => new Date(ms).toISOString();
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
    markSynced(db, id, at(8, 20));
  }
  seedGoogleEvent(db, {
    id: "g1",
    summary: "NB_Standup",
    start: { dateTime: iso(at(9)) },
    end: { dateTime: iso(at(9, 30)) },
  });
  seedGoogleEvent(db, {
    id: "g2",
    summary: "NB_Declined",
    start: { dateTime: iso(at(10)) },
    end: { dateTime: iso(at(11)) },
    attendees: [{ self: true, responseStatus: "declined" }],
  });
  seedOutlookEvent(db, {
    id: "o1",
    subject: "NB_Planning",
    start: { dateTime: iso(at(9, 15)).replace("Z", "0000"), timeZone: "UTC" },
    end: { dateTime: iso(at(10)).replace("Z", "0000"), timeZone: "UTC" },
  });
  seedItem(db, {
    service: "pagerduty",
    type: "oncall_shift",
    externalId: "s1",
    title: "shift",
    modifiedAt: at(8),
    metadata: {
      source: "pagerduty",
      user_name: "NB_Me",
      is_me: true,
      schedule_name: "NB_Primary",
      start_ms: at(0),
      end_ms: at(18),
      fetched_at_ms: at(8, 20),
      service_ids: ["PSVC"],
      service_names: ["payment-service"],
    },
  });
  seedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "i1",
    title: "NB_Checkout 500s",
    modifiedAt: at(8),
    metadata: { status: "triggered", severity: "P1", opened_at_ms: at(7) },
  });
  seedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "i2",
    title: "NB_Old resolved",
    modifiedAt: at(8),
    metadata: { status: "resolved", opened_at_ms: at(6) },
  });
  seedItem(db, {
    service: "github",
    type: "pr",
    externalId: "o/r#1",
    title: "NB_Review me",
    url: "https://github.com/o/r/pull/1",
    modifiedAt: at(8),
    metadata: { repo: "o/r", number: 1, state: "open", branch: "a" },
  });
  seedItem(db, {
    service: "github",
    type: "pr",
    externalId: "o/r#2",
    title: "NB_My PR",
    modifiedAt: at(8),
    metadata: { repo: "o/r", number: 2, state: "open", branch: "feat" },
  });
  seedItem(db, {
    service: "github_actions",
    type: "ci_run",
    externalId: "run1",
    title: "ci",
    modifiedAt: at(8),
    metadata: { repo: "o/r", branch: "feat", conclusion: "success" },
  });
  setSnapshot(db, "github", "review_requested", ["o/r#1"], at(8, 20));
  setSnapshot(db, "github", "authored_open", ["o/r#2"], at(8, 20));
  seedItem(db, {
    service: "jira",
    type: "issue",
    externalId: "J-1",
    title: "NB_Overdue",
    modifiedAt: at(8),
    metadata: { status_category: "todo", due_at_ms: Date.parse("2026-11-10") },
  });
  seedItem(db, {
    service: "jira",
    type: "issue",
    externalId: "J-2",
    title: "NB_Due today",
    modifiedAt: at(8),
    metadata: {
      status_category: "in_progress",
      due_at_ms: Date.parse(`${String(day.y)}-11-${String(day.d)}`),
    },
  });
  setSnapshot(db, "jira", "assigned", ["J-1", "J-2"], at(8, 20));
  for (const [id, labels, mod] of [
    ["m1", ["UNREAD"], at(7)],
    ["m2", ["UNREAD"], at(7, 30)],
    ["m3", ["INBOX"], at(7, 45)],
  ] as const) {
    seedItem(db, {
      service: "gmail",
      type: "email",
      externalId: id,
      title: `NB_Mail ${id}`,
      modifiedAt: mod,
      metadata: { threadId: id === "m3" ? "T3" : "T1", labelIds: labels, from: "NB_Ann <ann@x>" },
    });
  }
  seedItem(db, {
    service: "outlook",
    type: "email",
    externalId: "om1",
    title: "NB_Outlook mail",
    modifiedAt: at(7),
    metadata: { receivedDateTime: iso(at(7)), is_read: false },
  });
}

describe("the briefing, end to end", () => {
  test("1. seven sections: one scheduled run, one event, one toast, counts only in the toast", async () => {
    seedMorning();
    noNetwork();
    now = z(2026, 11, 12, 8, 0);
    const rt = runtime(LONDON);
    await rt.scheduler?.tick(); // baseline = 08:00: no history invented
    expect(rt.list(5)).toHaveLength(0);
    now = z(2026, 11, 12, 8, 31);
    await rt.scheduler?.tick();
    now = z(2026, 11, 12, 8, 32);
    await rt.scheduler?.tick();
    await rt.scheduler?.tick();
    const rows = rt.list(10);
    expect(rows).toHaveLength(1);
    const run = rt.get(rows[0]?.id ?? "");
    expect(run?.firedBy).toBe("schedule");
    expect(run?.status).toBe("ok");
    expect(run?.slotAt).toBe(z(2026, 11, 12, 8, 30));
    const md = run?.markdown ?? "";
    const heads = ["Calendar", "On call", "Incidents", "Reviews", "Tickets", "Mail", "Chat"].map(
      (h) => md.indexOf(`## ${h}`),
    );
    expect(heads.every((i) => i >= 0)).toBe(true);
    expect([...heads].sort((a, b) => a - b)).toEqual(heads);
    expect(md).toContain("## Data freshness");
    for (const s of [
      "NB_Standup",
      "NB_Planning",
      "NB_Checkout 500s",
      "NB_Review me",
      "NB_Overdue",
      "NB_Due today",
    ]) {
      expect(md).toContain(s);
    }
    expect(md).not.toContain("NB_Declined");
    expect(md).not.toContain("NB_Old resolved");
    expect(md).toContain("You are on call: ");
    expect(md).toContain("CI: ");
    expect(run?.counts).toMatchObject({
      meetings: 2,
      onCallShifts: 1,
      incidents: 1,
      reviews: 1,
      ticketsDue: 2,
      unreadMail: 2,
    });
    expect(events).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(run?.toastOutcome).toBe("delivered");
    expect(fetchCalls).toBe(0);
    // Privacy: no indexed string reaches the toast or the event.
    const out = JSON.stringify({ events, toasts, headline: run?.headline });
    expect(out).not.toContain("NB_");
  });

  test("2. gaps: no chat reader gives the chat Gaps line and still seven blocks; a missing iCloud row leaves the others", async () => {
    seedMorning();
    now = z(2026, 11, 12, 8, 40);
    const rt = runtime(LONDON);
    const run = await rt.runNow();
    expect(run.markdown).toContain("Unread Slack threads are not available yet");
    expect((run.markdown?.match(/^## /gm) ?? []).length).toBe(9); // 7 sections + Gaps + Data freshness
    expect(run.markdown).toContain("NB_Standup");
  });

  test("3. a deadline 23 h away with no activity: ten scans, exactly one toast and one notice", async () => {
    markSynced(db, "github", now);
    now = z(2026, 11, 12, 9);
    seedItem(db, {
      service: "github",
      type: "issue",
      externalId: "o/r#9",
      title: "NB_Milestone issue",
      modifiedAt: now - 30 * HOUR,
      metadata: { state: "open", due_at_ms: now + 23 * HOUR },
    });
    setSnapshot(db, "github", "assigned", ["o/r#9"], now);
    noNetwork();
    const rt = runtime(
      `${LONDON}[briefing.deadlines]\nenabled = true\n`.replace(
        "enabled = true\ntz",
        "enabled = false\ntz",
      ),
    );
    for (let i = 0; i < 10; i++) {
      await rt.scheduler?.tick();
      now += 15 * 60_000;
    }
    expect(toasts).toEqual([
      { title: "Nimbus deadlines", body: "1 open item due within 24 h with no recent activity" },
    ]);
    expect(db.query("SELECT count(*) AS n FROM deadline_notice").get()).toEqual({ n: 1 });
    expect(JSON.stringify(toasts)).not.toContain("NB_");
    expect(fetchCalls).toBe(0);
  });

  test("4. who is on call comes from the index with fetch thrown", () => {
    seedMorning();
    noNetwork();
    const r = queryOncallNow(db, {
      nowMs: z(2026, 11, 12, 9),
      term: "payment-service",
      serviceConfigs: [{ serviceId: "payment-service", pagerdutyServices: ["PSVC"] }],
    });
    expect(r.status).toBe("ok");
    expect(r.shifts[0]?.userName).toBe("NB_Me");
    expect(fetchCalls).toBe(0);
  });

  test("5. catch-up and skip: a restart inside three hours runs the slot, later records a skip with no toast", async () => {
    seedMorning();
    const first = runtime(LONDON);
    first.store.insertRun({
      firedAt: z(2026, 11, 11, 8, 30),
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: z(2026, 11, 11, 8, 30),
    });
    now = z(2026, 11, 12, 10, 29);
    await runtime(LONDON).scheduler?.tick();
    expect(events).toHaveLength(1);
    expect(first.list(10).filter((r) => r.slotAt === z(2026, 11, 12, 8, 30))).toHaveLength(1);

    db.run("DELETE FROM briefing_run WHERE slot_at = ?", [z(2026, 11, 12, 8, 30)]);
    events.length = 0;
    toasts.length = 0;
    now = z(2026, 11, 12, 11, 31);
    await runtime(LONDON).scheduler?.tick();
    expect(events).toHaveLength(0);
    expect(toasts).toHaveLength(0);
    expect(first.list(10).find((r) => r.status === "skipped")?.slotAt).toBe(z(2026, 11, 12, 8, 30));
  });

  test.each([
    ["spring forward (23 h day)", z(2026, 3, 29), z(2026, 3, 29, 7, 30)],
    ["fall back (25 h day)", z(2026, 10, 25), z(2026, 10, 25, 8, 30)],
  ])(
    "6. DST %s: the 08:30 local slot fires once and the day holds its events",
    async (_l, dayStart, slot) => {
      // 2026-03-29 and 2026-10-25 are Sundays: run on a weekday schedule of every day.
      const toml = LONDON.replace("1-5", "*");
      const evStart = dayStart + 12 * HOUR;
      for (const id of ["google_calendar"]) markSynced(db, id, dayStart);
      seedGoogleEvent(db, {
        id: "dst",
        summary: "NB_DST event",
        start: { dateTime: new Date(evStart).toISOString() },
        end: { dateTime: new Date(evStart + HOUR).toISOString() },
      });
      const yesterday = slot - 24 * HOUR;
      const rt = runtime(toml);
      rt.store.insertRun({
        firedAt: yesterday,
        firedBy: "schedule",
        status: "ok",
        headline: "y",
        slotAt: yesterday,
      });
      now = slot + 60_000;
      await rt.scheduler?.tick();
      await rt.scheduler?.tick();
      expect(rt.list(10).filter((r) => r.slotAt === slot)).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(rt.latest()?.markdown).toContain("NB_DST event");
    },
  );

  test("7. retention: a run older than retention_days is pruned by the next fire", async () => {
    seedMorning();
    now = z(2026, 11, 12, 8, 40);
    const rt = runtime(`${LONDON}retention_days = 7\n`);
    rt.store.insertRun({
      firedAt: now - 8 * 24 * HOUR,
      firedBy: "manual",
      status: "ok",
      headline: "old",
    });
    rt.store.insertRun({
      firedAt: now - 6 * 24 * HOUR,
      firedBy: "manual",
      status: "ok",
      headline: "new",
    });
    await rt.runNow();
    const headlines = rt.list(10).map((r) => r.headline);
    expect(headlines).not.toContain("old");
    expect(headlines).toContain("new");
  });

  test("zero egress: runs, a deadline scan and a tick leave egress_ledger unchanged", async () => {
    seedMorning();
    noNetwork();
    now = z(2026, 11, 12, 8, 40);
    const count = () =>
      (db.query("SELECT count(*) AS n FROM egress_ledger").get() as { n: number }).n;
    const before = count();
    const rt = runtime(
      `${LONDON}[briefing.deadlines]\nenabled = true\n`.replace(
        "enabled = true\ntz",
        "enabled = false\ntz",
      ),
    );
    await rt.runNow();
    await rt.scheduler?.tick();
    expect(count()).toBe(before);
    expect(fetchCalls).toBe(0);
  });
});
