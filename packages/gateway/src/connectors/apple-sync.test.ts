/**
 * Tests for the Apple (iCloud Mail + Calendar) gateway sync.
 *
 * Uses a real in-memory SQLite index (via createMemoryIndexDb) and fake
 * fetchers — no real IMAP/CalDAV sockets are opened.
 *
 * Coverage targets:
 *  - Happy path: two messages are fetched and upserted as `apple:email` rows.
 *  - Correct external_id: prefers RFC message-id; falls back to mailbox:uv:uid.
 *  - Preview cap: body_preview is at most 2000 chars.
 *  - loadMailConfig null path: returns null when creds are absent → sync is a noop.
 *  - loadMailConfig uses fixed iCloud IMAP constants (host, port, secure).
 *  - loadMailConfig mailbox fallback: defaults to "INBOX" when vault key absent.
 *  - Calendar pass: apple:event rows land alongside apple:email rows.
 *  - Calendar pass: override events keyed by uid:recurrenceId.
 *  - Calendar pass: attendee metadata stored correctly.
 *  - Calendar pass: fetch error degrades gracefully (mail result preserved).
 *  - Calendar pass: skipped when CalDAV creds absent.
 */
import { describe, expect, test } from "bun:test";
import type { AppleEventFetcher, AppleEventFetchOutcome } from "./_lib/apple-caldav-fetch.ts";
import { type AppleSyncableOptions, createAppleSyncable, loadMailConfig } from "./apple-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  expectSyncNoopResult,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import type { ImapMessageInput } from "./imap-email-mapping.ts";
import type { ImapFetchOutcome } from "./imap-sync.ts";

// ─── ICS Fixtures ─────────────────────────────────────────────────────────────

/**
 * A CalDAV ICS payload with two VEVENTs across two calendars:
 *  - "Work"     → event-work-1 (timed, with an ATTENDEE)
 *  - "Personal" → event-personal-1 (timed) + event-personal-2 (override with RECURRENCE-ID)
 */
const WORK_ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:event-work-1",
  "SUMMARY:Team standup",
  "DTSTART:20260601T090000Z",
  "DTEND:20260601T091500Z",
  "DTSTAMP:20260531T080000Z",
  "ATTENDEE:mailto:colleague@example.com",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const PERSONAL_ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:event-personal-1",
  "SUMMARY:Doctor appointment",
  "DTSTART:20260602T140000Z",
  "DTEND:20260602T150000Z",
  "DTSTAMP:20260601T100000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-personal-1",
  "RECURRENCE-ID:20260609T140000Z",
  "SUMMARY:Doctor appointment (moved)",
  "DTSTART:20260609T160000Z",
  "DTEND:20260609T170000Z",
  "DTSTAMP:20260605T100000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// ─── Mail Fixtures ────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<ImapMessageInput> = {}): ImapMessageInput {
  return {
    uid: 1,
    mailbox: "INBOX",
    uidValidity: "99",
    messageId: "<msg-1@icloud.com>",
    subject: "Test subject",
    date: new Date(Date.now() - 3_600_000).toISOString(),
    from: ["sender@icloud.com"],
    to: ["recipient@example.com"],
    cc: [],
    attachments: [],
    preview: "Short preview text",
    ...overrides,
  };
}

/** A fake IMAP fetcher that returns `messages` immediately (no network). */
function fakeFetcher(messages: ImapMessageInput[]): AppleSyncableOptions["fetchMessages"] {
  return async (_config, _limit): Promise<ImapFetchOutcome> => ({
    ok: true,
    messages,
  });
}

/** A fake IMAP fetcher that returns `{ ok: false }` to simulate a connection error. */
function errorFetcher(): AppleSyncableOptions["fetchMessages"] {
  return async (_config, _limit): Promise<ImapFetchOutcome> => ({
    ok: false,
    error: "IMAP connection refused",
  });
}

/** A fake CalDAV fetcher returning the given calendar entries. */
function fakeEventFetcher(entries: { calendar: string; ics: string }[]): AppleEventFetcher {
  return async (): Promise<AppleEventFetchOutcome> => ({
    ok: true,
    events: entries,
  });
}

/** A fake CalDAV fetcher that returns an error. */
function errorEventFetcher(): AppleEventFetcher {
  return async (): Promise<AppleEventFetchOutcome> => ({
    ok: false,
    error: "CalDAV connection refused",
  });
}

/** No-op CalDAV fetcher (returns zero events, no error). */
function noopEventFetcher(): AppleEventFetcher {
  return fakeEventFetcher([]);
}

/** Vault with both required secrets present. */
function credsVault(email = "user@icloud.com", appPw = "xxxx-yyyy-zzzz-aaaa") {
  return createStubVault({
    "apple.icloud_email": email,
    "apple.icloud_app_password": appPw,
  });
}

/** Vault with no apple secrets (simulates unconfigured connector). */
function emptyVault() {
  return createStubVault({
    "apple.icloud_email": null,
    "apple.icloud_app_password": null,
  });
}

// ─── loadMailConfig ────────────────────────────────────────────────────────────

describe("loadMailConfig", () => {
  test("returns null when icloud_email is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": null,
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns null when icloud_app_password is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": null,
    });
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns null when icloud_email is empty string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
    });
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns null when icloud_app_password is empty string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "",
    });
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result).toBeNull();
  });

  test("returns fixed iCloud IMAP config when both secrets are present", async () => {
    const db = createMemoryIndexDb();
    const vault = credsVault();
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result).not.toBeNull();
    expect(result?.host).toBe("imap.mail.me.com");
    expect(result?.port).toBe(993);
    expect(result?.secure).toBe(true);
    expect(result?.username).toBe("user@icloud.com");
    expect(result?.password).toBe("xxxx-yyyy-zzzz-aaaa");
  });

  test("defaults mailbox to INBOX when apple.mailbox is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = credsVault();
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result?.mailbox).toBe("INBOX");
  });

  test("uses configured mailbox when apple.mailbox is set", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.mailbox": "Archive",
    });
    const result = await loadMailConfig(syncTestContext(db, vault, "apple"));
    expect(result?.mailbox).toBe("Archive");
  });
});

// ─── createAppleSyncable — mail path ─────────────────────────────────────────

describe("createAppleSyncable (mail path)", () => {
  test("serviceId is 'apple'", () => {
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: noopEventFetcher(),
    });
    expect(syncable.serviceId).toBe("apple");
  });

  test("noop when vault creds are absent (no rows upserted, null cursor)", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage()]),
      fetchEvents: noopEventFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, emptyVault(), "apple"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "apple", 0);
  });

  test("upserts two apple:email rows on happy path", async () => {
    const db = createMemoryIndexDb();
    const messages = [
      makeMessage({ uid: 1, messageId: "<m1@icloud.com>", subject: "First" }),
      makeMessage({ uid: 2, messageId: "<m2@icloud.com>", subject: "Second" }),
    ];
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher(messages),
      fetchEvents: noopEventFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "apple", 2);
  });

  test("external_id is the RFC message-id when present", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ messageId: "<unique@icloud.com>" })]),
      fetchEvents: noopEventFetcher(),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    const row = db
      .prepare("SELECT external_id FROM item WHERE service = 'apple' AND type = 'email' LIMIT 1")
      .get() as { external_id: string } | undefined;
    expect(row?.external_id).toBe("<unique@icloud.com>");
  });

  test("external_id falls back to mailbox:uidValidity:uid when messageId absent", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([
        makeMessage({ uid: 42, mailbox: "INBOX", uidValidity: "77", messageId: null }),
      ]),
      fetchEvents: noopEventFetcher(),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    const row = db
      .prepare("SELECT external_id FROM item WHERE service = 'apple' AND type = 'email' LIMIT 1")
      .get() as { external_id: string } | undefined;
    expect(row?.external_id).toBe("INBOX:77:42");
  });

  test("body_preview is capped at 2000 chars", async () => {
    const db = createMemoryIndexDb();
    const longPreview = "A".repeat(5000);
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ preview: longPreview })]),
      fetchEvents: noopEventFetcher(),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'apple' AND type = 'email' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    expect((row?.body_preview ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("service column is 'apple' for all upserted rows", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage()]),
      fetchEvents: noopEventFetcher(),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    const rows = db.prepare("SELECT service FROM item WHERE service = 'apple'").all() as {
      service: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.service).toBe("apple");
  });

  test("returns a cursor string on success", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: noopEventFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    expect(typeof r.cursor).toBe("string");
    expect(r.cursor).toContain("nimbus-apple1:");
  });

  test("IMAP fetch error returns a transient result (preserves cursor, 0 upserts)", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: errorFetcher(),
      fetchEvents: noopEventFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), "existing-cursor");
    expect(r.itemsUpserted).toBe(0);
    // On {ok:false} with an existing cursor, the cursor is preserved.
    expect(r.cursor).toBe("existing-cursor");
    expectServiceItemCount(db, "apple", 0);
  });

  test("skips messages that map to null (no messageId and invalid uid)", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ uid: 0, messageId: null })]),
      fetchEvents: noopEventFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "apple", 0);
  });

  test("ensureAppleMcpRunning is called before fetch", async () => {
    const db = createMemoryIndexDb();
    const calls: string[] = [];
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {
        calls.push("ensure");
      },
      fetchMessages: async (config, limit) => {
        calls.push("fetch");
        return fakeFetcher([])(config, limit);
      },
      fetchEvents: noopEventFetcher(),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    expect(calls[0]).toBe("ensure");
    expect(calls[1]).toBe("fetch");
  });
});

// ─── createAppleSyncable — calendar path ──────────────────────────────────────

describe("createAppleSyncable (calendar path)", () => {
  test("apple:event rows land in SQLite alongside apple:email rows", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ messageId: "<m1@icloud.com>" })]),
      fetchEvents: fakeEventFetcher([
        { calendar: "Work", ics: WORK_ICS },
        { calendar: "Personal", ics: PERSONAL_ICS },
      ]),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);

    // 1 email + 3 events (work-1, personal-1 master, personal-1 override)
    expect(r.itemsUpserted).toBe(4);

    const emailRows = db
      .prepare("SELECT * FROM item WHERE service = 'apple' AND type = 'email'")
      .all();
    expect(emailRows).toHaveLength(1);

    const eventRows = db
      .prepare("SELECT * FROM item WHERE service = 'apple' AND type = 'event'")
      .all();
    expect(eventRows).toHaveLength(3);
  });

  test("override occurrence has external_id of uid:recurrenceId", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: fakeEventFetcher([{ calendar: "Personal", ics: PERSONAL_ICS }]),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);

    const rows = db
      .prepare("SELECT external_id FROM item WHERE service = 'apple' AND type = 'event'")
      .all() as { external_id: string }[];
    const ids = rows.map((r) => r.external_id).sort();
    expect(ids).toContain("event-personal-1");
    expect(ids).toContain("event-personal-1:20260609T140000Z");
  });

  test("attendee emails are stored in metadata", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: fakeEventFetcher([{ calendar: "Work", ics: WORK_ICS }]),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);

    const row = db
      .prepare(
        "SELECT metadata FROM item WHERE service = 'apple' AND type = 'event' AND external_id = 'event-work-1'",
      )
      .get() as { metadata: string } | undefined;
    expect(row).not.toBeUndefined();
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(Array.isArray(meta["attendees"])).toBe(true);
    expect(meta["attendees"]).toContain("colleague@example.com");
  });

  test("calendar name is stored in metadata.calendar", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: fakeEventFetcher([{ calendar: "Work", ics: WORK_ICS }]),
    });
    await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);

    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'apple' AND type = 'event' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["calendar"]).toBe("Work");
  });

  test("per-calendar cap accumulates across ICS entries for the same calendar", async () => {
    const db = createMemoryIndexDb();
    // Two single-event ICS blobs, same calendar, distinct UIDs (so they don't dedup).
    const evt = (uid: string) =>
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "SUMMARY:Capped event",
        "DTSTART:20260601T090000Z",
        "DTEND:20260601T093000Z",
        "DTSTAMP:20260531T080000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: fakeEventFetcher([
        { calendar: "Work", ics: evt("cap-1") },
        { calendar: "Work", ics: evt("cap-2") },
      ]),
    });
    // cal_max_instances=1 → only the first event of "Work" may be indexed, even
    // though it arrives across two separate entries (regression: per-entry reset).
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      "apple.cal_max_instances": "1",
    });
    await syncable.sync(syncTestContext(db, vault, "apple"), null);

    const eventRows = db
      .prepare("SELECT external_id FROM item WHERE service = 'apple' AND type = 'event'")
      .all();
    expect(eventRows).toHaveLength(1);
  });

  test("CalDAV fetch error: mail result is preserved, calendar rows absent", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([makeMessage({ messageId: "<m1@icloud.com>" })]),
      fetchEvents: errorEventFetcher(),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);

    // Mail pass succeeded: 1 email upserted, cursor is set
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).not.toBeNull();

    // No calendar rows
    const eventRows = db
      .prepare("SELECT * FROM item WHERE service = 'apple' AND type = 'event'")
      .all();
    expect(eventRows).toHaveLength(0);
  });

  test("calendar pass skipped when creds absent (noop vault)", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: noopEventFetcher(),
    });
    // emptyVault has no creds → mail pass is noop, cal pass is skipped
    const r = await syncable.sync(syncTestContext(db, emptyVault(), "apple"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "apple", 0);
  });

  test("calendar events from two calendars are all indexed", async () => {
    const db = createMemoryIndexDb();
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: fakeEventFetcher([
        { calendar: "Work", ics: WORK_ICS },
        { calendar: "Personal", ics: PERSONAL_ICS },
      ]),
    });
    const r = await syncable.sync(syncTestContext(db, credsVault(), "apple"), null);
    // 1 from Work + 2 from Personal (master + override)
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "apple", 3);
  });

  test("maxInstancesPerCalendar cap is honoured", async () => {
    // Build an ICS with 3 events
    const lines = ["BEGIN:VCALENDAR"];
    for (let i = 1; i <= 3; i++) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:cap-event-${i}`,
        `SUMMARY:Event ${i}`,
        `DTSTART:2026060${i}T090000Z`,
        `DTEND:2026060${i}T100000Z`,
        `DTSTAMP:20260531T080000Z`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    const manyIcs = lines.join("\r\n");

    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "user@icloud.com",
      "apple.icloud_app_password": "xxxx-yyyy-zzzz-aaaa",
      // Cap at 2 instances per calendar
      "apple.cal_max_instances": "2",
    });
    const syncable = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: fakeFetcher([]),
      fetchEvents: fakeEventFetcher([{ calendar: "Test", ics: manyIcs }]),
    });
    const r = await syncable.sync(syncTestContext(db, vault, "apple"), null);
    // Only 2 of the 3 events should be indexed due to the cap
    expect(r.itemsUpserted).toBe(2);
  });
});
