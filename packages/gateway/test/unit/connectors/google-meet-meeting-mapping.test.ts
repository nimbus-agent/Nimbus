import { describe, expect, test } from "bun:test";

import {
  type GoogleMeetParticipant,
  mapGoogleMeetParticipant,
  mapGoogleMeetParticipants,
  mapGoogleMeetRecordToItem,
} from "../../../src/connectors/google-meet-meeting-mapping.ts";

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

  test("a record with no participants keeps the v1 title and an empty roster", () => {
    const row = mapGoogleMeetRecordToItem(record(), { syncedAt: SYNCED_AT, participants: [] });
    expect(row?.title).toBe("Meeting 2024-01-02");
    expect(row?.bodyPreview).toBe("Meeting 2024-01-02");
    expect(row?.metadata["participants"]).toEqual([]);
    expect(row?.metadata["participantCount"]).toBe(0);
  });

  test("omitting participants entirely behaves like an empty roster", () => {
    const row = mapGoogleMeetRecordToItem(record(), { syncedAt: SYNCED_AT });
    expect(row?.metadata["participants"]).toEqual([]);
    expect(row?.metadata["participantCount"]).toBe(0);
    expect(row?.title).toBe("Meeting 2024-01-02");
  });
});

// ---------------------------------------------------------------------------
// mapGoogleMeetParticipant — the three-member union
// ---------------------------------------------------------------------------

describe("mapGoogleMeetParticipant", () => {
  test("maps a signed-in user to its directory id + display name", () => {
    expect(
      mapGoogleMeetParticipant({
        name: "conferenceRecords/abc123/participants/p1",
        earliestStartTime: "2024-01-02T09:01:00Z",
        latestEndTime: "2024-01-02T10:29:00Z",
        signedinUser: { user: "users/1122334455", displayName: "Ada Lovelace" },
      }),
    ).toEqual({ kind: "signed_in", id: "users/1122334455", displayName: "Ada Lovelace" });
  });

  test("keeps a signed-in user that has an id but no display name (robot account)", () => {
    expect(mapGoogleMeetParticipant({ signedinUser: { user: "users/9" } })).toEqual({
      kind: "signed_in",
      id: "users/9",
      displayName: null,
    });
  });

  test("maps an anonymous user to a name-only entry with no id", () => {
    expect(mapGoogleMeetParticipant({ anonymousUser: { displayName: "Guest Ada" } })).toEqual({
      kind: "anonymous",
      id: null,
      displayName: "Guest Ada",
    });
  });

  test("maps a phone user to the partially-redacted number Google returns", () => {
    expect(mapGoogleMeetParticipant({ phoneUser: { displayName: "+1 555-***-**89" } })).toEqual({
      kind: "phone",
      id: null,
      displayName: "+1 555-***-**89",
    });
  });

  test("returns null for entries carrying no identity at all", () => {
    expect(mapGoogleMeetParticipant(null)).toBeNull();
    expect(mapGoogleMeetParticipant("nope")).toBeNull();
    expect(mapGoogleMeetParticipant([])).toBeNull();
    // No union member.
    expect(mapGoogleMeetParticipant({ name: "conferenceRecords/c/participants/p" })).toBeNull();
    // Union member present but empty.
    expect(mapGoogleMeetParticipant({ signedinUser: {} })).toBeNull();
    expect(mapGoogleMeetParticipant({ signedinUser: { user: "", displayName: "" } })).toBeNull();
    expect(mapGoogleMeetParticipant({ anonymousUser: {} })).toBeNull();
    expect(mapGoogleMeetParticipant({ phoneUser: { displayName: "" } })).toBeNull();
  });

  /**
   * The people-data guard: join/leave times answer "how long did each person
   * stay", which is attendance surveillance rather than "who was in that
   * meeting". They must never reach the index.
   */
  test("join/leave times and the participant resource name are NEVER carried through", () => {
    const mapped = mapGoogleMeetParticipant({
      name: "conferenceRecords/abc123/participants/p1",
      earliestStartTime: "2024-01-02T09:01:00Z",
      latestEndTime: "2024-01-02T10:29:00Z",
      signedinUser: { user: "users/1122334455", displayName: "Ada Lovelace" },
    });
    expect(mapped).not.toBeNull();
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("2024-01-02T09:01:00Z");
    expect(serialized).not.toContain("2024-01-02T10:29:00Z");
    expect(serialized).not.toContain("participants/p1");
    expect(Object.keys(mapped ?? {}).sort()).toEqual(["displayName", "id", "kind"]);
  });
});

describe("mapGoogleMeetParticipants", () => {
  test("skips unmappable entries and preserves order", () => {
    const mapped = mapGoogleMeetParticipants(
      [
        { signedinUser: { user: "users/1", displayName: "Ada" } },
        { name: "no-union-member" },
        { anonymousUser: { displayName: "Guest" } },
      ],
      10,
    );
    expect(mapped.map((p) => p.displayName)).toEqual(["Ada", "Guest"]);
  });

  test("clips at max", () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({
      signedinUser: { user: `users/${String(i)}`, displayName: `P${String(i)}` },
    }));
    expect(mapGoogleMeetParticipants(raw, 5)).toHaveLength(5);
  });

  test("returns an empty list for a non-array", () => {
    expect(mapGoogleMeetParticipants(undefined, 10)).toEqual([]);
    expect(mapGoogleMeetParticipants({ participants: [] }, 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Participant detail on the meeting item
// ---------------------------------------------------------------------------

function participant(displayName: string | null, id: string | null = null): GoogleMeetParticipant {
  return { kind: id === null ? "anonymous" : "signed_in", id, displayName };
}

describe("mapGoogleMeetRecordToItem — participant detail", () => {
  test("the roster lands in metadata verbatim", () => {
    const participants = [participant("Ada Lovelace", "users/1"), participant("Guest")];
    const row = mapGoogleMeetRecordToItem(record(), { syncedAt: SYNCED_AT, participants });
    expect(row?.metadata["participants"]).toEqual(participants);
    expect(row?.metadata["participantCount"]).toBe(2);
  });

  test("title leads with participant names, then the start date", () => {
    const row = mapGoogleMeetRecordToItem(record(), {
      syncedAt: SYNCED_AT,
      participants: [
        participant("Ada Lovelace", "users/1"),
        participant("Grace Hopper", "users/2"),
      ],
    });
    expect(row?.title).toBe("Meeting with Ada Lovelace, Grace Hopper — 2024-01-02");
  });

  test("title caps at three names and reports the remainder", () => {
    const participants = ["A", "B", "C", "D", "E"].map((n) => participant(n, `users/${n}`));
    const row = mapGoogleMeetRecordToItem(record(), { syncedAt: SYNCED_AT, participants });
    expect(row?.title).toBe("Meeting with A, B, C +2 — 2024-01-02");
  });

  test("the `+N` remainder counts participants clipped away by the fetch cap too", () => {
    const participants = ["A", "B", "C", "D"].map((n) => participant(n, `users/${n}`));
    const row = mapGoogleMeetRecordToItem(record(), {
      syncedAt: SYNCED_AT,
      participants,
      // 40 people were in the meeting; only 4 were stored.
      participantCount: 40,
    });
    expect(row?.title).toBe("Meeting with A, B, C +37 — 2024-01-02");
    expect(row?.metadata["participantCount"]).toBe(40);
  });

  test("title falls back to the id when startTime is absent", () => {
    const noStart = record();
    delete noStart["startTime"];
    const row = mapGoogleMeetRecordToItem(noStart, {
      syncedAt: SYNCED_AT,
      participants: [participant("Ada Lovelace", "users/1")],
    });
    expect(row?.title).toBe("Meeting with Ada Lovelace — abc123");
  });

  test("nameless participants (ids only) leave the v1 title intact but still count", () => {
    const row = mapGoogleMeetRecordToItem(record(), {
      syncedAt: SYNCED_AT,
      participants: [{ kind: "signed_in", id: "users/1", displayName: null }],
    });
    expect(row?.title).toBe("Meeting 2024-01-02");
    expect(row?.bodyPreview).toBe("Meeting 2024-01-02");
    expect(row?.metadata["participantCount"]).toBe(1);
  });

  test("bodyPreview carries the full stored roster so every attendee is searchable", () => {
    const participants = ["A", "B", "C", "D", "E"].map((n) => participant(n, `users/${n}`));
    const row = mapGoogleMeetRecordToItem(record(), { syncedAt: SYNCED_AT, participants });
    expect(row?.bodyPreview).toBe("A, B, C, D, E");
  });
});
