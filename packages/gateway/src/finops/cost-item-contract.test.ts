import { describe, expect, test } from "bun:test";
import {
  COST_ALLOCATION_TYPE,
  COST_RECOMMENDATION_TYPE,
  COST_SERVICE_IDS,
  costRowExternalId,
  DAY_MS,
  finalizedFor,
  isCostItemType,
  isCostServiceId,
  RESTATE_WINDOW_DAYS,
  sanitiseScopeId,
  seriesHashOf,
  seriesKeyOf,
  startOfUtcDay,
  utcDateString,
} from "./cost-item-contract.ts";

describe("seriesHashOf", () => {
  test("is 16 lower-case hex and stable", () => {
    const a = seriesHashOf("service", null, "AmazonSNS");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(seriesHashOf("service", null, "AmazonSNS")).toBe(a);
  });

  test("tuples that differ only in where a pipe falls hash differently", () => {
    expect(seriesHashOf("tag", "a|b", "c")).not.toBe(seriesHashOf("tag", "a", "b|c"));
    expect(seriesHashOf("tag", "a\\", "|c")).not.toBe(seriesHashOf("tag", "a", "\\|c"));
  });

  test("a null key and an empty key are the same series", () => {
    expect(seriesHashOf("service", null, "x")).toBe(seriesHashOf("service", "", "x"));
  });
});

describe("seriesKeyOf", () => {
  test("joins the five parts with pipes and escapes a pipe inside a part", () => {
    expect(seriesKeyOf("vantage", "default", "service", null, "EC2")).toBe(
      "vantage|default|service||EC2",
    );
    expect(seriesKeyOf("vantage", "default", "tag", "k", "a|b")).toBe(
      "vantage|default|tag|k|a\\|b",
    );
  });
});

describe("sanitiseScopeId and costRowExternalId", () => {
  test("a clean scope is kept", () => {
    expect(sanitiseScopeId("rprt_abc-123")).toBe("rprt_abc-123");
    expect(sanitiseScopeId(null)).toBe("default");
    expect(sanitiseScopeId("")).toBe("default");
  });

  test("a scope with a slash, a space or a newline becomes 12 hex and never appears raw", () => {
    for (const raw of ["a/b", "a b", "a\nb"]) {
      const out = sanitiseScopeId(raw);
      expect(out).toMatch(/^[0-9a-f]{12}$/);
      expect(out).not.toContain(raw);
    }
  });

  test("an over-long scope is hashed", () => {
    expect(sanitiseScopeId("a".repeat(41))).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the id is scope:hash:date and at most 80 characters", () => {
    const hash = seriesHashOf("service", null, "EC2");
    const id = costRowExternalId("rprt_x", hash, Date.UTC(2026, 10, 3));
    expect(id).toBe(`rprt_x:${hash}:2026-11-03`);
    const long = costRowExternalId("a".repeat(500), hash, Date.UTC(2026, 10, 3));
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

describe("days and finalization", () => {
  test("startOfUtcDay floors and utcDateString formats", () => {
    const ms = Date.UTC(2026, 10, 3, 17, 45, 1);
    expect(startOfUtcDay(ms)).toBe(Date.UTC(2026, 10, 3));
    expect(utcDateString(ms)).toBe("2026-11-03");
  });

  test("a day is provisional inside the restate window and final on its boundary", () => {
    const syncedAt = Date.UTC(2026, 10, 10);
    const boundary = syncedAt - RESTATE_WINDOW_DAYS * DAY_MS;
    expect(finalizedFor(boundary, syncedAt)).toBe(true);
    expect(finalizedFor(boundary + 1, syncedAt)).toBe(false);
  });
});

describe("type guards", () => {
  test("isCostItemType", () => {
    expect(isCostItemType(COST_ALLOCATION_TYPE)).toBe(true);
    expect(isCostItemType(COST_RECOMMENDATION_TYPE)).toBe(true);
    expect(isCostItemType("incident")).toBe(false);
  });

  test("isCostServiceId knows the five ids", () => {
    expect(COST_SERVICE_IDS).toHaveLength(5);
    expect(isCostServiceId("vantage")).toBe(true);
    expect(isCostServiceId("github")).toBe(false);
  });
});
