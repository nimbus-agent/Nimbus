import { describe, expect, it } from "bun:test";
import {
  extractPrMetadataForIndex,
  shouldRefreshMergeableState,
} from "../../../src/connectors/github-sync.ts";

describe("github-sync: PR mergeable_state enrichment", () => {
  it("captures mergeable, mergeable_state, and mergeable_state_fetched_at_ms on an open PR", () => {
    const pr = {
      number: 42,
      state: "open",
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
      labels: [],
      user: { login: "alice" },
      draft: false,
    };
    const nowMs = 1_715_000_000_000;
    const out = extractPrMetadataForIndex("nimbus-agent/payments", pr, nowMs);
    expect(out.mergeable).toBe(true);
    expect(out.mergeable_state).toBe("clean");
    expect(out.mergeable_state_fetched_at_ms).toBe(nowMs);
  });

  it("captures mergeable_state='dirty' on a conflict PR", () => {
    const pr = {
      number: 7,
      state: "open",
      merged: false,
      mergeable: false,
      mergeable_state: "dirty",
      labels: [],
      user: { login: "bob" },
      draft: false,
    };
    const nowMs = 1_715_000_000_000;
    const out = extractPrMetadataForIndex("nimbus-agent/payments", pr, nowMs);
    expect(out.mergeable).toBe(false);
    expect(out.mergeable_state).toBe("dirty");
    expect(out.mergeable_state_fetched_at_ms).toBe(nowMs);
  });

  it("omits mergeable + mergeable_state when not present on input (list-endpoint shape)", () => {
    const pr = {
      number: 9,
      state: "open",
      merged: false,
      labels: [],
      user: { login: "alice" },
      draft: false,
    };
    const out = extractPrMetadataForIndex("nimbus-agent/payments", pr);
    expect(out.mergeable).toBeUndefined();
    expect(out.mergeable_state).toBeUndefined();
  });

  it("ignores non-string mergeable_state defensively", () => {
    const pr = {
      number: 10,
      state: "open",
      merged: false,
      mergeable: true,
      mergeable_state: 42,
      labels: [],
      user: { login: "alice" },
      draft: false,
    };
    const out = extractPrMetadataForIndex("nimbus-agent/payments", pr);
    expect(out.mergeable_state).toBeUndefined();
  });
});

describe("github-sync: shouldRefreshMergeableState policy", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;

  it("returns true when mergeable_state is null and PR was updated in the last 7d", () => {
    const now = 1_715_000_000_000;
    expect(
      shouldRefreshMergeableState({
        mergeableState: null,
        mergeableStateFetchedAtMs: null,
        updatedAtMs: now - 3 * DAY,
        nowMs: now,
      }),
    ).toBe(true);
  });

  it("returns false when mergeable_state is null but PR was last updated >7d ago", () => {
    const now = 1_715_000_000_000;
    expect(
      shouldRefreshMergeableState({
        mergeableState: null,
        mergeableStateFetchedAtMs: null,
        updatedAtMs: now - 10 * DAY,
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("returns true when indexed mergeable_state is older than 24h", () => {
    const now = 1_715_000_000_000;
    expect(
      shouldRefreshMergeableState({
        mergeableState: "clean",
        mergeableStateFetchedAtMs: now - 25 * HOUR,
        updatedAtMs: now - 1 * DAY,
        nowMs: now,
      }),
    ).toBe(true);
  });

  it("returns false when indexed mergeable_state was fetched <24h ago (thrash guard)", () => {
    const now = 1_715_000_000_000;
    expect(
      shouldRefreshMergeableState({
        mergeableState: "clean",
        mergeableStateFetchedAtMs: now - 12 * HOUR,
        updatedAtMs: now - 1 * DAY,
        nowMs: now,
      }),
    ).toBe(false);
  });
});

describe("github-sync: mergeable_state refresh-policy boundaries", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;

  it("returns true when updated_at is exactly at the 7d window edge", () => {
    const now = 1_715_000_000_000;
    expect(
      shouldRefreshMergeableState({
        mergeableState: null,
        mergeableStateFetchedAtMs: null,
        updatedAtMs: now - 7 * DAY, // exactly 7d ago
        nowMs: now,
      }),
    ).toBe(true);
  });

  it("returns false when refresh-age is exactly at the 24h boundary", () => {
    const now = 1_715_000_000_000;
    expect(
      shouldRefreshMergeableState({
        mergeableState: "clean",
        mergeableStateFetchedAtMs: now - 24 * HOUR,
        updatedAtMs: now - 1 * DAY,
        nowMs: now,
      }),
    ).toBe(false);
  });
});
