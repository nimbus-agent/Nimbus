import { describe, expect, it } from "bun:test";

import { mapZoomMeetingToItem } from "./zoom-meeting-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

describe("mapZoomMeetingToItem", () => {
  it("maps a populated meeting row", () => {
    const row = mapZoomMeetingToItem(
      {
        id: 83476203401,
        uuid: "abcd==",
        host_id: "host-1",
        topic: "Weekly Sync",
        type: 2,
        start_time: "2026-06-01T10:00:00Z",
        duration: 30,
        timezone: "UTC",
        agenda: "Project status",
        join_url: "https://zoom.us/j/83476203401?pwd=xyz",
        created_at: "2026-05-25T12:00:00Z",
      },
      { syncedAt: SYNCED_AT },
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("zoom");
    expect(row?.type).toBe("meeting");
    expect(row?.externalId).toBe("83476203401");
    expect(row?.title).toBe("Weekly Sync");
    expect(row?.url).toBe("https://zoom.us/j/83476203401?pwd=xyz");
    expect(row?.canonicalUrl).toBe("https://zoom.us/j/83476203401?pwd=xyz");
    expect(row?.metadata).toMatchObject({
      meeting_id: 83476203401,
      uuid: "abcd==",
      host_id: "host-1",
      topic: "Weekly Sync",
      type: 2,
      duration_min: 30,
      timezone: "UTC",
      agenda: "Project status",
      join_url: "https://zoom.us/j/83476203401?pwd=xyz",
    });
    expect(row?.metadata["start_time"]).toBe(Date.parse("2026-06-01T10:00:00Z"));
    expect(row?.metadata["created_at"]).toBe(Date.parse("2026-05-25T12:00:00Z"));
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-25T12:00:00Z"));
    expect(row?.syncedAt).toBe(SYNCED_AT);
  });

  it("falls back title to `Meeting <id>` when topic is missing", () => {
    const row = mapZoomMeetingToItem(
      { id: 1234, start_time: "2026-06-01T10:00:00Z" },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.title).toBe("Meeting 1234");
  });

  it("returns null when id is missing or non-numeric", () => {
    expect(mapZoomMeetingToItem({ topic: "no id" }, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapZoomMeetingToItem({ id: "not-a-number" }, { syncedAt: SYNCED_AT })).toBeNull();
  });

  it("nulls url + canonicalUrl when join_url is missing", () => {
    const row = mapZoomMeetingToItem(
      { id: 1, topic: "x", start_time: "2026-06-01T10:00:00Z" },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
  });

  it("modifiedAt prefers created_at over start_time (start_time may be future-dated)", () => {
    const row = mapZoomMeetingToItem(
      {
        id: 9,
        topic: "future",
        start_time: "2099-01-01T00:00:00Z",
        created_at: "2026-05-25T12:00:00Z",
      },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-25T12:00:00Z"));
  });

  it("modifiedAt falls back to syncedAt when created_at is missing (no start_time fallback)", () => {
    const row = mapZoomMeetingToItem({ id: 7, topic: "no times" }, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(SYNCED_AT);
  });

  it("tolerates a non-record input by returning null", () => {
    expect(mapZoomMeetingToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapZoomMeetingToItem("not an object", { syncedAt: SYNCED_AT })).toBeNull();
  });
});
