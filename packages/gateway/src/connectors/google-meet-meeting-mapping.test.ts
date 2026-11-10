import { describe, expect, test } from "bun:test";

import {
  type GoogleMeetParticipant,
  mapGoogleMeetParticipant,
  mapGoogleMeetParticipants,
  mapGoogleMeetRecordToItem,
} from "./google-meet-meeting-mapping.ts";

const ctx = { syncedAt: 1_000 };
const person = (name: string): GoogleMeetParticipant => ({
  kind: "signed_in",
  id: null,
  displayName: name,
});

describe("mapGoogleMeetParticipant", () => {
  test("maps each union member and keeps the identifying fields", () => {
    expect(
      mapGoogleMeetParticipant({ signedinUser: { user: "users/1", displayName: "Ada" } }),
    ).toEqual({ kind: "signed_in", id: "users/1", displayName: "Ada" });
    expect(mapGoogleMeetParticipant({ anonymousUser: { displayName: "Guest" } })).toEqual({
      kind: "anonymous",
      id: null,
      displayName: "Guest",
    });
    expect(mapGoogleMeetParticipant({ phoneUser: { displayName: "+1 555" } })).toEqual({
      kind: "phone",
      id: null,
      displayName: "+1 555",
    });
  });

  test("a blank row is not a person", () => {
    expect(mapGoogleMeetParticipant({ signedinUser: { user: "", displayName: "" } })).toBeNull();
    expect(mapGoogleMeetParticipant({ anonymousUser: {} })).toBeNull();
    expect(mapGoogleMeetParticipant({ phoneUser: { displayName: "" } })).toBeNull();
    expect(mapGoogleMeetParticipant({})).toBeNull();
    expect(mapGoogleMeetParticipant("x")).toBeNull();
  });

  test("a signed-in user with only an id is kept", () => {
    expect(mapGoogleMeetParticipant({ signedinUser: { user: "users/9" } })).toEqual({
      kind: "signed_in",
      id: "users/9",
      displayName: null,
    });
  });
});

describe("mapGoogleMeetParticipants", () => {
  test("skips unusable entries, clips at max, and tolerates a non-array", () => {
    const raw = [
      { anonymousUser: { displayName: "A" } },
      {},
      { anonymousUser: { displayName: "B" } },
      { anonymousUser: { displayName: "C" } },
    ];
    expect(mapGoogleMeetParticipants(raw, 2).map((p) => p.displayName)).toEqual(["A", "B"]);
    expect(mapGoogleMeetParticipants("nope", 2)).toEqual([]);
  });
});

describe("mapGoogleMeetRecordToItem", () => {
  test("titles by who was there, capped at three names plus a remainder", () => {
    const row = mapGoogleMeetRecordToItem(
      {
        name: "conferenceRecords/abc",
        startTime: "2024-01-02T10:00:00Z",
        endTime: "2024-01-02T11:00:00Z",
        space: "spaces/s",
      },
      {
        ...ctx,
        participants: [person("Ada"), person("Grace"), person("Linus"), person("Ken")],
        participantCount: 6,
      },
    );
    expect(row?.externalId).toBe("abc");
    expect(row?.title).toBe("Meeting with Ada, Grace, Linus +3 — 2024-01-02");
    expect(row?.bodyPreview).toBe("Ada, Grace, Linus, Ken");
    expect(row?.modifiedAt).toBe(Date.parse("2024-01-02T11:00:00Z"));
  });

  test("with no named participants the title is the date, or the id when the start is unreadable", () => {
    const dated = mapGoogleMeetRecordToItem(
      { name: "conferenceRecords/abc", startTime: "2024-01-02T10:00:00Z" },
      ctx,
    );
    expect(dated?.title).toBe("Meeting 2024-01-02");
    expect(dated?.bodyPreview).toBe("Meeting 2024-01-02");
    const undated = mapGoogleMeetRecordToItem(
      { name: "conferenceRecords/abc", startTime: "garbage", endTime: "" },
      ctx,
    );
    expect(undated?.title).toBe("Meeting abc");
    expect(undated?.modifiedAt).toBe(1_000);
  });

  test("a name without a collection prefix is its own id; an empty id is rejected", () => {
    expect(mapGoogleMeetRecordToItem({ name: "bare" }, ctx)?.externalId).toBe("bare");
    expect(mapGoogleMeetRecordToItem({ name: "conferenceRecords/" }, ctx)).toBeNull();
    expect(mapGoogleMeetRecordToItem({ name: "" }, ctx)).toBeNull();
    expect(mapGoogleMeetRecordToItem([], ctx)).toBeNull();
  });
});
