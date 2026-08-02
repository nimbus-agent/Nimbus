import { describe, expect, test } from "bun:test";

import { buildItemListSql, parseRelativeSinceToWindowMs } from "./item-list-query.ts";

describe("buildItemListSql", () => {
  test("matches IPC-style github + pr + since + limit", () => {
    const { sql, vals } = buildItemListSql({
      services: ["github"],
      types: ["pr"],
      sinceMs: 1_700_000_000_000,
      limit: 50,
    });
    expect(sql).toContain("service IN (?)");
    expect(sql).toContain("type = ?");
    expect(sql).toContain("modified_at >= ?");
    expect(vals).toEqual(["github", "pr", 1_700_000_000_000, 50]);
  });
});

describe("parseRelativeSinceToWindowMs", () => {
  test("7d window from fixed now", () => {
    const now = 1_800_000_000_000;
    const got = parseRelativeSinceToWindowMs("7d", now);
    expect(got).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });

  test("supports hours, minutes, seconds (case-insensitive)", () => {
    const now = 2_000_000_000_000;
    expect(parseRelativeSinceToWindowMs("24H", now)).toBe(now - 24 * 60 * 60 * 1000);
    expect(parseRelativeSinceToWindowMs("30m", now)).toBe(now - 30 * 60 * 1000);
    expect(parseRelativeSinceToWindowMs("45s", now)).toBe(now - 45 * 1000);
  });

  test("returns undefined for unparseable input", () => {
    expect(parseRelativeSinceToWindowMs("not-a-window", 0)).toBeUndefined();
    expect(parseRelativeSinceToWindowMs("7", 0)).toBeUndefined();
    expect(parseRelativeSinceToWindowMs("7x", 0)).toBeUndefined();
  });
});

describe("buildItemListSql (additional branches)", () => {
  test("multiple services + multiple types use IN (?,...) placeholders", () => {
    const { sql, vals } = buildItemListSql({
      services: ["github", "gitlab"],
      types: ["pr", "issue", "deployment"],
      limit: 25,
    });
    expect(sql).toContain("service IN (?, ?)");
    expect(sql).toContain("type IN (?, ?, ?)");
    expect(vals).toEqual(["github", "gitlab", "pr", "issue", "deployment", 25]);
  });

  test("untilMs adds modified_at <= bound", () => {
    const { sql, vals } = buildItemListSql({
      services: [],
      types: [],
      sinceMs: 1_000,
      untilMs: 2_000,
      limit: 10,
    });
    expect(sql).toContain("modified_at >= ?");
    expect(sql).toContain("modified_at <= ?");
    expect(vals).toEqual([1_000, 2_000, 10]);
  });

  test("empty services/types and no time bounds emits no WHERE clause", () => {
    const { sql, vals } = buildItemListSql({
      services: [],
      types: [],
      limit: 5,
    });
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("body,");
    expect(sql).toContain("body_preview");
    expect(sql).toMatch(/FROM item\s+ORDER BY modified_at DESC LIMIT \?/);
    expect(vals).toEqual([5]);
  });
});
