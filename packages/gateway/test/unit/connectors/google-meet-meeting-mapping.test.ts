import { describe, expect, test } from "bun:test";

import { mapGoogleMeetRecordToItem } from "../../../src/connectors/google-meet-meeting-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "conferenceRecords/abc123",
    startTime: "2024-01-02T09:00:00Z",
    endTime: "2024-01-02T10:30:00Z",
    space: "spaces/space1",
    ...over,
  };
}

describe("mapGoogleMeetRecordToItem", () => {
  test("maps a well-formed conference record to a google_meet:meeting item", () => {
    const row = mapGoogleMeetRecordToItem(record(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("google_meet");
    expect(row.type).toBe("meeting");
    // external_id strips the conferenceRecords/ prefix.
    expect(row.externalId).toBe("abc123");
    // Title is derived from the start date.
    expect(row.title).toBe("Meeting 2024-01-02");
    expect(row.bodyPreview).toBe("Meeting 2024-01-02");
    // Conference records carry no productUrl.
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    // modifiedAt prefers endTime.
    expect(row.modifiedAt).toBe(Date.parse("2024-01-02T10:30:00Z"));
    expect(row.syncedAt).toBe(SYNCED_AT);
    expect(row.metadata["name"]).toBe("conferenceRecords/abc123");
    expect(row.metadata["space"]).toBe("spaces/space1");
    expect(row.metadata["startTime"]).toBe("2024-01-02T09:00:00Z");
    expect(row.metadata["endTime"]).toBe("2024-01-02T10:30:00Z");
  });

  test("falls back to startTime then syncedAt for modifiedAt", () => {
    const noEnd = record();
    delete noEnd["endTime"];
    const row = mapGoogleMeetRecordToItem(noEnd, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(Date.parse("2024-01-02T09:00:00Z"));

    const noTimes = record();
    delete noTimes["endTime"];
    delete noTimes["startTime"];
    const row2 = mapGoogleMeetRecordToItem(noTimes, { syncedAt: SYNCED_AT });
    expect(row2?.modifiedAt).toBe(SYNCED_AT);
  });

  test("derives title from id when startTime is absent", () => {
    const noStart = record();
    delete noStart["startTime"];
    const row = mapGoogleMeetRecordToItem(noStart, { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("Meeting abc123");
  });

  test("stores null metadata for absent optional fields", () => {
    const sparse = { name: "conferenceRecords/onlyid" };
    const row = mapGoogleMeetRecordToItem(sparse, { syncedAt: SYNCED_AT });
    expect(row?.externalId).toBe("onlyid");
    expect(row?.metadata["space"]).toBeNull();
    expect(row?.metadata["startTime"]).toBeNull();
    expect(row?.metadata["endTime"]).toBeNull();
  });

  test("returns null for a non-object input", () => {
    expect(mapGoogleMeetRecordToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapGoogleMeetRecordToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapGoogleMeetRecordToItem([], { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("returns null when name is missing or empty", () => {
    expect(
      mapGoogleMeetRecordToItem(record({ name: undefined }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
    expect(mapGoogleMeetRecordToItem(record({ name: "" }), { syncedAt: SYNCED_AT })).toBeNull();
  });
});
