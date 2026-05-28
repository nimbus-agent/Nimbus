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
});
