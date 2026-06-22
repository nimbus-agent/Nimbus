import { describe, expect, test } from "bun:test";
import { buildRelatedQuery, runClipRelated } from "./clip-related.ts";

describe("buildRelatedQuery", () => {
  test("selection present → selection is the query", () => {
    expect(buildRelatedQuery({ title: "Docs", selection: "vector index" }).query).toBe(
      "vector index",
    );
  });
  test("no selection → title is the query", () => {
    expect(buildRelatedQuery({ title: "Vector indexes" }).query).toBe("Vector indexes");
  });
  test("canonicalUrl host is parsed into excludeHost", () => {
    expect(buildRelatedQuery({ title: "x", canonicalUrl: "https://ex.com/p" }).excludeHost).toBe(
      "ex.com",
    );
  });
  test("empty inputs → empty query, no host", () => {
    const q = buildRelatedQuery({});
    expect(q.query).toBe("");
    expect(q.excludeHost).toBeUndefined();
  });
});

describe("runClipRelated", () => {
  test("delegates to the injected search and passes the built query", async () => {
    const calls: Array<{ query: string; limit: number }> = [];
    const out = await runClipRelated(
      {
        search: async (query, limit) => {
          calls.push({ query, limit });
          return [{ id: "drive:1", title: "Hit", service: "drive", snippet: "s", url: "u" }];
        },
      },
      { selection: "vector index", limit: 5 },
    );
    expect(calls).toEqual([{ query: "vector index", limit: 5 }]);
    expect(out.items).toHaveLength(1);
  });

  test("empty query short-circuits to no results (no search call)", async () => {
    let called = false;
    const out = await runClipRelated(
      {
        search: async () => {
          called = true;
          return [];
        },
      },
      {},
    );
    expect(called).toBe(false);
    expect(out.items).toEqual([]);
  });

  test("filters out hits whose url host matches excludeHost", async () => {
    const out = await runClipRelated(
      {
        search: async () => [
          { id: "a", title: "self", service: "nimbus", snippet: "", url: "https://ex.com/self" },
          { id: "b", title: "other", service: "drive", snippet: "", url: "https://other.com/x" },
        ],
      },
      { title: "x", canonicalUrl: "https://ex.com/p" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["b"]);
  });
});
