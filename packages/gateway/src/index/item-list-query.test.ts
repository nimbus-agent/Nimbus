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

  test("ids restricts with an IN (...) clause, AND-ed with other filters", () => {
    const { sql, vals } = buildItemListSql({
      services: ["github"],
      types: [],
      ids: ["p1", "p2"],
      limit: 10,
    });
    expect(sql).toContain("service IN (?)");
    expect(sql).toContain("id IN (?, ?)");
    expect(vals).toEqual(["github", "p1", "p2", 10]);
  });

  test("an empty ids array matches nothing rather than emitting IN ()", () => {
    const { sql, vals } = buildItemListSql({
      services: [],
      types: [],
      ids: [],
      limit: 10,
    });
    expect(sql).not.toContain("IN ()");
    expect(sql).toContain("1 = 0");
    expect(vals).toEqual([10]);
  });

  test("no ids filter (undefined) leaves the query unrestricted", () => {
    const { sql } = buildItemListSql({ services: [], types: [], limit: 10 });
    expect(sql).not.toContain("id IN");
    expect(sql).not.toContain("1 = 0");
  });

  test("idInSql embeds the given SELECT verbatim as a subquery, no per-row bind params", () => {
    // The fixture binds its own value rather than inlining `'pr'`, matching what the real
    // predicate builders hand in (`buildNotTouchingSql` and friends bind every value they take).
    // The point of the case survives: the subquery contributes exactly ONE parameter here, not
    // one per matched row, however many rows it goes on to match.
    const { sql, vals } = buildItemListSql({
      services: ["github"],
      types: [],
      idInSql: {
        sql: "SELECT i.id FROM item i WHERE i.type = ? AND NOT EXISTS (SELECT 1 WHERE 0)",
        vals: ["pr"],
      },
      limit: 10,
    });
    expect(sql).toContain(
      "id IN (SELECT i.id FROM item i WHERE i.type = ? AND NOT EXISTS (SELECT 1 WHERE 0))",
    );
    expect(vals).toEqual(["github", "pr", 10]);
  });

  test("idInSql's own vals splice in at the right position for a large id-matching set", () => {
    // Exercises the actual reason this filter exists: a huge matching set costs exactly the
    // subquery's own parameter count (one, here), never one bind parameter per matched row.
    const { sql, vals } = buildItemListSql({
      services: [],
      types: [],
      idInSql: { sql: "SELECT id FROM item WHERE service = ?", vals: ["gitlab"] },
      sinceMs: 500,
      limit: 10,
    });
    expect(sql).toContain("id IN (SELECT id FROM item WHERE service = ?)");
    expect(vals).toEqual(["gitlab", 500, 10]);
  });
});
