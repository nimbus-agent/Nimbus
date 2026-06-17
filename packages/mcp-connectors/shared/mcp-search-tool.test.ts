import { describe, expect, test } from "bun:test";
import { matchesResult, searchToolInputSchema } from "./mcp-search-tool.ts";

describe("searchToolInputSchema", () => {
  test("accepts query alone and query+limit", () => {
    const s = searchToolInputSchema();
    const a = s.safeParse({ query: "x" });
    expect(a.success).toBe(true);
    if (a.success) {
      expect(a.data).toEqual({ query: "x" });
    }
    const b = s.safeParse({ query: "x", limit: 5 });
    expect(b.success).toBe(true);
    if (b.success) {
      expect(b.data).toEqual({ query: "x", limit: 5 });
    }
  });

  test("rejects empty query", () => {
    expect(searchToolInputSchema().safeParse({ query: "" }).success).toBe(false);
  });

  test("rejects limit over the default cap of 100, below 1, or non-integer", () => {
    const s = searchToolInputSchema();
    expect(s.safeParse({ query: "x", limit: 101 }).success).toBe(false);
    expect(s.safeParse({ query: "x", limit: 0 }).success).toBe(false);
    expect(s.safeParse({ query: "x", limit: 1.5 }).success).toBe(false);
  });

  test("honors a custom cap", () => {
    const s = searchToolInputSchema(200);
    expect(s.safeParse({ query: "x", limit: 200 }).success).toBe(true);
    expect(s.safeParse({ query: "x", limit: 201 }).success).toBe(false);
  });

  test("exposes a .shape for tool registration", () => {
    expect(typeof searchToolInputSchema().shape).toBe("object");
  });
});

describe("matchesResult", () => {
  const filter = (rows: readonly unknown[], opts: { query: string; limit?: number }) =>
    rows.filter((r) => String(r).includes(opts.query)).slice(0, opts.limit ?? rows.length);

  test("filters array rows into a { matches } envelope", () => {
    const res = matchesResult(["apple", "banana", "grape"], filter, { query: "a" });
    expect(JSON.parse(res.content[0].text)).toEqual({ matches: ["apple", "banana", "grape"] });
  });

  test("non-array rows yield empty matches", () => {
    for (const bad of [null, undefined, {}, "str", 42] as unknown[]) {
      const res = matchesResult(bad, filter, { query: "a" });
      expect(JSON.parse(res.content[0].text)).toEqual({ matches: [] });
    }
  });

  test("passes query+limit through to the filter unchanged", () => {
    const seen: unknown[] = [];
    const spy = (rows: readonly unknown[], opts: { query: string; limit?: number }) => {
      seen.push(opts);
      return rows;
    };
    matchesResult([1, 2], spy, { query: "q", limit: 7 });
    expect(seen[0]).toEqual({ query: "q", limit: 7 });
  });

  test("returns a single text-part McpListResult", () => {
    const res = matchesResult([], filter, { query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
  });
});
