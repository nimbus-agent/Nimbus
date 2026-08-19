import { describe, expect, test } from "bun:test";
import { MAX_BUCKETS, StatsBucketError, splitBuckets } from "./stats-buckets.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = 1_700_000_000_000;

describe("splitBuckets", () => {
  test("whole multiple: newest bucket ends exactly at untilMs", () => {
    const b = splitBuckets(NOW, 4 * WEEK, WEEK);
    expect(b.length).toBe(4);
    expect(b[3]?.endMs).toBe(NOW);
    expect(b[0]?.startMs).toBe(NOW - 4 * WEEK);
  });

  test("buckets are contiguous, ascending, and non-overlapping", () => {
    const b = splitBuckets(NOW, 4 * WEEK, WEEK);
    for (let i = 1; i < b.length; i++) {
      expect(b[i]?.startMs).toBe(b[i - 1]?.endMs);
    }
  });

  test("partial trailing bucket keeps its TRUE short bounds, not a padded week", () => {
    // 30 days at weekly granularity = 4 whole weeks + a 2-day remainder.
    const b = splitBuckets(NOW, 30 * DAY, WEEK);
    expect(b.length).toBe(5);
    const oldest = b[0];
    expect(oldest?.startMs).toBe(NOW - 30 * DAY);
    expect((oldest?.endMs ?? 0) - (oldest?.startMs ?? 0)).toBe(2 * DAY);
    expect(b[4]?.endMs).toBe(NOW);
  });

  test("bucket == window yields exactly one bucket", () => {
    const b = splitBuckets(NOW, WEEK, WEEK);
    expect(b.length).toBe(1);
    expect(b[0]).toEqual({ startMs: NOW - WEEK, endMs: NOW });
  });

  // Spec 6.1: unsatisfiable input errors rather than silently collapsing.
  test("bucket > window is an error naming BOTH values", () => {
    let msg = "";
    try {
      splitBuckets(NOW, 3 * DAY, WEEK);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toContain(String(3 * DAY));
    expect(msg).toContain(String(WEEK));
  });

  test("zero and negative durations are rejected", () => {
    expect(() => splitBuckets(NOW, 0, WEEK)).toThrow(StatsBucketError);
    expect(() => splitBuckets(NOW, WEEK, 0)).toThrow(StatsBucketError);
    expect(() => splitBuckets(NOW, -WEEK, WEEK)).toThrow(StatsBucketError);
    expect(() => splitBuckets(NOW, WEEK, -DAY)).toThrow(StatsBucketError);
  });

  test("non-integer durations are rejected", () => {
    expect(() => splitBuckets(NOW, 1.5, 1)).toThrow(StatsBucketError);
  });

  // Spec 6.1: over-cap REJECTS, never truncates. A truncated series that looks
  // complete is worse than an error.
  test("exceeding MAX_BUCKETS throws rather than returning the first N", () => {
    const windowMs = (MAX_BUCKETS + 1) * DAY;
    expect(() => splitBuckets(NOW, windowMs, DAY)).toThrow(StatsBucketError);
  });

  test("exactly MAX_BUCKETS is allowed", () => {
    expect(splitBuckets(NOW, MAX_BUCKETS * DAY, DAY).length).toBe(MAX_BUCKETS);
  });
});
