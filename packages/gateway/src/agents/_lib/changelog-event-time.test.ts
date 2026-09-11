import { describe, expect, test } from "bun:test";
import { eventTimeFor } from "./changelog-event-time.ts";

describe("eventTimeFor", () => {
  test("a merged PR reports merged_at as a real event time", () => {
    expect(eventTimeFor("merged_pr", { merged_at: 1_700_000_000_000 }, 1_800_000_000_000)).toEqual({
      atMs: 1_700_000_000_000,
      source: "event",
    });
  });

  test("an unmerged PR is excluded, never approximated", () => {
    // github-sync.ts writes merged_at ONLY on a merged PR, so absence means "not merged".
    // Falling back to modified_at here would put every open PR in the changelog.
    expect(eventTimeFor("merged_pr", {}, 1_800_000_000_000)).toBeNull();
  });

  test("a string where a number belongs is refused, not coerced", () => {
    expect(eventTimeFor("merged_pr", { merged_at: "1700000000000" }, 1_800_000_000_000)).toBeNull();
  });

  test("a deployment reports modified_at, flagged as index-derived", () => {
    expect(eventTimeFor("deployment", {}, 1_800_000_000_000)).toEqual({
      atMs: 1_800_000_000_000,
      source: "index",
    });
  });

  test("an incident reports opened_at_ms as a real event time", () => {
    expect(
      eventTimeFor("incident_opened", { opened_at_ms: 1_700_000_000_000 }, 1_800_000_000_000),
    ).toEqual({ atMs: 1_700_000_000_000, source: "event" });
  });

  test("an incident missing opened_at_ms is excluded", () => {
    expect(eventTimeFor("incident_opened", {}, 1_800_000_000_000)).toBeNull();
  });

  test("incident resolution reports modified_at, flagged as index-derived", () => {
    expect(eventTimeFor("incident_resolved", { status: "resolved" }, 1_800_000_000_000)).toEqual({
      atMs: 1_800_000_000_000,
      source: "index",
    });
  });

  test("an incident that is NOT resolved yields no resolution time", () => {
    // The SQL already filters on status, so this is defence in depth — but without it the
    // test above passes for a reason that has nothing to do with the status it passes in,
    // which makes it a test that cannot fail in the direction that matters.
    expect(
      eventTimeFor("incident_resolved", { status: "triggered" }, 1_800_000_000_000),
    ).toBeNull();
    expect(eventTimeFor("incident_resolved", {}, 1_800_000_000_000)).toBeNull();
  });

  test("a non-object metadata value is refused rather than throwing", () => {
    expect(eventTimeFor("merged_pr", null, 1_800_000_000_000)).toBeNull();
    expect(eventTimeFor("merged_pr", "not an object", 1_800_000_000_000)).toBeNull();
  });
});
