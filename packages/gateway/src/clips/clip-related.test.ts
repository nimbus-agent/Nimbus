import { describe, expect, test } from "bun:test";
import {
  buildRelatedQuery,
  type RelatedHit,
  type RelatedInput,
  runClipRelated,
} from "./clip-related.ts";

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
          return [
            {
              id: "drive:1",
              title: "Hit",
              service: "drive",
              type: "page",
              snippet: "s",
              url: "u",
              modified_at: 1,
            },
          ];
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
          {
            id: "a",
            title: "self",
            service: "nimbus",
            type: "page",
            snippet: "",
            url: "https://ex.com/self",
            modified_at: 1,
          },
          {
            id: "b",
            title: "other",
            service: "drive",
            type: "page",
            snippet: "",
            url: "https://other.com/x",
            modified_at: 2,
          },
        ],
      },
      { title: "x", canonicalUrl: "https://ex.com/p" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["b"]);
  });

  test("non-string title/selection are coerced (no throw, empty query)", async () => {
    let called = false;
    const search = async (): Promise<RelatedHit[]> => {
      called = true;
      return [];
    };
    const out = await runClipRelated({ search }, {
      title: 123,
      selection: { x: 1 },
    } as unknown as RelatedInput);
    expect(called).toBe(false);
    expect(out.items).toEqual([]);
  });

  test("non-number limit falls back to the default (no NaN to search)", async () => {
    const seen: number[] = [];
    const search = async (_q: string, limit: number): Promise<RelatedHit[]> => {
      seen.push(limit);
      return [];
    };
    await runClipRelated({ search }, {
      title: "hi",
      limit: "abc",
    } as unknown as RelatedInput);
    expect(seen).toEqual([10]);
  });

  test("null input → empty, no throw", async () => {
    const out = await runClipRelated({ search: async () => [] }, null as unknown as RelatedInput);
    expect(out.items).toEqual([]);
  });
});
