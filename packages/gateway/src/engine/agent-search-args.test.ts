import { describe, expect, test } from "bun:test";
import { clipToolString, parseSearchLocalIndexArgs } from "./agent-search-args.ts";

describe("parseSearchLocalIndexArgs", () => {
  test("defaults: limit 20, two context chunks, semantic on, no filters", () => {
    const a = parseSearchLocalIndexArgs({});
    expect(a.query).toEqual({ limit: 20 });
    expect(a.service).toBeUndefined();
    expect(a.semantic).toBe(true);
    expect(a.contextChunks).toBe(2);
  });

  test("trims and clips filters, and a blank one is absent", () => {
    const a = parseSearchLocalIndexArgs({ name: "  deploy ", service: "   ", itemType: "pr" });
    expect(a.query).toEqual({ limit: 20, name: "deploy", itemType: "pr" });
    expect(a.service).toBeUndefined();
    expect(parseSearchLocalIndexArgs({ service: "github" }).query.service).toBe("github");
    expect(clipToolString("x".repeat(3000))).toHaveLength(2000);
  });

  test("clamps limit to 1..500 and contextChunks to 0..8, and ignores non-numbers", () => {
    expect(parseSearchLocalIndexArgs({ limit: 9999, contextChunks: 99 })).toMatchObject({
      query: { limit: 500 },
      contextChunks: 8,
    });
    expect(parseSearchLocalIndexArgs({ limit: 0, contextChunks: -3 })).toMatchObject({
      query: { limit: 1 },
      contextChunks: 0,
    });
    expect(parseSearchLocalIndexArgs({ limit: 7.9, contextChunks: "4" })).toMatchObject({
      query: { limit: 7 },
      contextChunks: 2,
    });
    expect(parseSearchLocalIndexArgs({ limit: Number.NaN }).query.limit).toBe(20);
  });

  test("only an explicit false turns semantic off", () => {
    expect(parseSearchLocalIndexArgs({ semantic: false }).semantic).toBe(false);
    expect(parseSearchLocalIndexArgs({ semantic: 0 }).semantic).toBe(true);
  });
});
