/**
 * Unit tests for mapAppleEventToItem (F2).
 *
 * Coverage targets:
 *  - Timed event → correct row shape + metadata incl. attendees
 *  - Override occurrence → external_id is `uid:recurrenceId`
 *  - No-UID event → null
 *  - 5000-char description → preview capped at 2000 chars
 *  - modifiedAt falls back: dtstamp → start → syncedAt
 *  - All-day event → allDay:true in metadata
 *  - Empty summary → "(untitled event)" title
 *  - Long summary → clamped at 256 chars
 */
import { describe, expect, test } from "bun:test";
import type { ParsedEvent } from "@nimbus-dev/sdk";
import { mapAppleEventToItem } from "./apple-event-mapping.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    uid: "abc-123",
    recurrenceId: null,
    summary: "Weekly Standup",
    description: "Discuss progress",
    location: "Room 4B",
    start: "20260601T090000Z",
    end: "20260601T091500Z",
    allDay: false,
    status: "CONFIRMED",
    organizer: "boss@icloud.com",
    attendees: ["a@icloud.com", "b@icloud.com"],
    rrule: null,
    dtstamp: "20260531T120000Z",
    ...overrides,
  };
}

const CTX = { calendar: "Work", syncedAt: 1_700_000_000_000 };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("mapAppleEventToItem", () => {
  test("timed event produces correct row shape and metadata with attendees", () => {
    const ev = makeEvent();
    const row = mapAppleEventToItem(ev, CTX);
    expect(row).not.toBeNull();
    expect(row?.service).toBe("apple");
    expect(row?.type).toBe("event");
    expect(row?.externalId).toBe("abc-123");
    expect(row?.title).toBe("Weekly Standup");
    expect(row?.bodyPreview).toBe("Discuss progress");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.syncedAt).toBe(CTX.syncedAt);

    const meta = row?.metadata;
    expect(meta?.["uid"]).toBe("abc-123");
    expect(meta?.["calendar"]).toBe("Work");
    expect(meta?.["start"]).toBe("20260601T090000Z");
    expect(meta?.["end"]).toBe("20260601T091500Z");
    expect(meta?.["allDay"]).toBe(false);
    expect(meta?.["location"]).toBe("Room 4B");
    expect(meta?.["organizer"]).toBe("boss@icloud.com");
    expect(meta?.["status"]).toBe("CONFIRMED");
    expect(meta?.["recurrence"]).toBeNull();
    expect(meta?.["attendees"]).toEqual(["a@icloud.com", "b@icloud.com"]);
  });

  test("modifiedAt comes from dtstamp when present", () => {
    const ev = makeEvent({ dtstamp: "20260531T120000Z" });
    const row = mapAppleEventToItem(ev, CTX);
    // 20260531T120000Z = 2026-05-31T12:00:00Z
    const expected = Date.parse("2026-05-31T12:00:00Z");
    expect(row?.modifiedAt).toBe(expected);
  });

  test("modifiedAt falls back to start when dtstamp absent", () => {
    const ev = makeEvent({ dtstamp: null, start: "20260601T090000Z" });
    const row = mapAppleEventToItem(ev, CTX);
    const expected = Date.parse("2026-06-01T09:00:00Z");
    expect(row?.modifiedAt).toBe(expected);
  });

  test("modifiedAt falls back to syncedAt when both dtstamp and start are absent", () => {
    const ev = makeEvent({ dtstamp: null, start: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("override occurrence: external_id is uid:recurrenceId", () => {
    const ev = makeEvent({ recurrenceId: "20260601T090000Z" });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.externalId).toBe("abc-123:20260601T090000Z");
  });

  test("no-UID event returns null", () => {
    const ev = makeEvent({ uid: "" });
    expect(mapAppleEventToItem(ev, CTX)).toBeNull();
  });

  test("whitespace-only UID returns null", () => {
    const ev = makeEvent({ uid: "   " });
    expect(mapAppleEventToItem(ev, CTX)).toBeNull();
  });

  test("5000-char description is capped at 2000 chars in preview", () => {
    const ev = makeEvent({ description: "X".repeat(5000) });
    const row = mapAppleEventToItem(ev, CTX);
    expect((row?.bodyPreview ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("null description produces empty preview", () => {
    const ev = makeEvent({ description: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.bodyPreview).toBe("");
  });

  test("null summary produces '(untitled event)' title", () => {
    const ev = makeEvent({ summary: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.title).toBe("(untitled event)");
  });

  test("empty summary produces '(untitled event)' title", () => {
    const ev = makeEvent({ summary: "   " });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.title).toBe("(untitled event)");
  });

  test("long summary is clamped to 256 chars (with ellipsis)", () => {
    const ev = makeEvent({ summary: "S".repeat(300) });
    const row = mapAppleEventToItem(ev, CTX);
    // clamp appends "…" making total 257 chars; check it is ≤257
    expect((row?.title ?? "").length).toBeLessThanOrEqual(257);
    expect(row?.title?.endsWith("…")).toBe(true);
  });

  test("all-day event is reflected in metadata.allDay", () => {
    const ev = makeEvent({ allDay: true, start: "20260601", end: "20260602" });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.metadata["allDay"]).toBe(true);
  });

  test("recurrenceId null → no colon in external_id", () => {
    const ev = makeEvent({ recurrenceId: null });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.externalId).toBe("abc-123");
    expect(row?.externalId.includes(":")).toBe(false);
  });

  test("rrule is surfaced as metadata.recurrence", () => {
    const ev = makeEvent({ rrule: "FREQ=WEEKLY;BYDAY=MO" });
    const row = mapAppleEventToItem(ev, CTX);
    expect(row?.metadata["recurrence"]).toBe("FREQ=WEEKLY;BYDAY=MO");
  });
});

// ─── iCalendar date parsing (reached through `modifiedAt`) ───────────────────

describe("mapAppleEventToItem — DTSTAMP / DTSTART parsing", () => {
  test("accepts an ISO-8601 timestamp directly", () => {
    // CalDAV servers are not uniform: some emit the RFC 5545 compact form,
    // some an ISO-8601 string. Both must resolve to the same instant.
    const iso = mapAppleEventToItem(makeEvent({ dtstamp: "2026-05-31T12:00:00Z" }), CTX);
    const compact = mapAppleEventToItem(makeEvent({ dtstamp: "20260531T120000Z" }), CTX);
    expect(iso?.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00Z"));
    expect(iso?.modifiedAt).toBe(compact?.modifiedAt);
  });

  test("treats an all-day DATE value as midnight UTC", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "20260601", allDay: true }), CTX);
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T00:00:00Z"));
  });

  test("treats a floating (no-Z) datetime as UTC", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "20260601T090000" }), CTX);
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T09:00:00Z"));
  });

  // An unparseable DTSTAMP must fall through the chain rather than poison
  // `modified_at` with NaN — a NaN there sorts unpredictably and makes the
  // item invisible to every `--since` window.
  test("falls through to DTSTART when DTSTAMP is unparseable", () => {
    const row = mapAppleEventToItem(
      makeEvent({ dtstamp: "garbage", start: "20260601T090000Z" }),
      CTX,
    );
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T09:00:00Z"));
  });

  // Compact-SHAPED but not a real date: the regex matches, `Date.parse` does not.
  test("rejects a compact-form value that is not a real date", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "20261332", start: null }), CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("falls all the way through to syncedAt when both values are unparseable", () => {
    const row = mapAppleEventToItem(makeEvent({ dtstamp: "garbage", start: "also-garbage" }), CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });
});
