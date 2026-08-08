import { describe, expect, it } from "bun:test";

import { filterZoomMeetings } from "../src/search-filter.ts";

const SAMPLE = [
  { id: 1, topic: "Weekly sync", agenda: "status updates", host_id: "h-alice" },
  { id: 2, topic: "1:1 with Bob", agenda: "", host_id: "h-alice" },
  { id: 3, topic: "Design review", agenda: "scope cuts", host_id: "h-eve" },
];

describe("filterZoomMeetings", () => {
  it("matches topic substring (case-insensitive)", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "weekly" })).toHaveLength(1);
  });

  it("matches agenda substring", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "scope" })).toHaveLength(1);
  });

  it("limit caps the matches", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "with", limit: 0 })).toHaveLength(0);
  });

  it("returns empty when no match", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "no-match" })).toHaveLength(0);
  });

  // --- additional branch coverage ---

  it("returns empty array when query is blank (whitespace only)", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "   " })).toHaveLength(0);
  });

  it("returns empty array when query is empty string", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "" })).toHaveLength(0);
  });

  it("uses default limit of 50 when limit is undefined", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      topic: "standup",
      agenda: "daily",
      host_id: "h-main",
    }));
    const result = filterZoomMeetings(many, { query: "standup" });
    expect(result).toHaveLength(50);
  });

  it("stops at explicit limit when matches exceed it", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      topic: "Planning",
      agenda: "sprint",
      host_id: "h-owner",
    }));
    const result = filterZoomMeetings(many, { query: "planning", limit: 4 });
    expect(result).toHaveLength(4);
  });

  it("skips null entries (asRecord returns undefined)", () => {
    const items: unknown[] = [null, { id: 1, topic: "Meeting", agenda: "discuss", host_id: "h-x" }];
    expect(filterZoomMeetings(items, { query: "meeting" })).toHaveLength(1);
  });

  it("skips primitive entries like numbers and strings", () => {
    const items: unknown[] = [
      42,
      "some-string",
      { id: 2, topic: "Retrospective", agenda: "lessons", host_id: "h-y" },
    ];
    expect(filterZoomMeetings(items, { query: "retrospective" })).toHaveLength(1);
  });

  it("skips array entries (asRecord treats arrays as undefined)", () => {
    const items: unknown[] = [
      ["not", "a", "record"],
      { id: 3, topic: "Kickoff", agenda: "planning", host_id: "h-z" },
    ];
    expect(filterZoomMeetings(items, { query: "kickoff" })).toHaveLength(1);
  });

  it("matches on host_id field", () => {
    const result = filterZoomMeetings(SAMPLE, { query: "h-eve" });
    expect(result).toHaveLength(1);
    const row = result[0] as Record<string, unknown>;
    expect(row["id"]).toBe(3);
  });

  it("tolerates missing topic/agenda/host_id fields (stringField returns empty string)", () => {
    const items: unknown[] = [
      { id: 10 },
      { id: 11, topic: "All-hands", agenda: "updates", host_id: "h-cfo" },
    ];
    // the empty-fields entry has no match text; only the populated one matches
    expect(filterZoomMeetings(items, { query: "all-hands" })).toHaveLength(1);
    // empty fields still dont match on a real term
    expect(filterZoomMeetings([{ id: 10 }], { query: "anything" })).toHaveLength(0);
  });

  it("handles queries with special characters", () => {
    expect(filterZoomMeetings(SAMPLE, { query: "1:1" })).toHaveLength(1);
  });
});
