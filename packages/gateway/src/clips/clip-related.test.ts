import { describe, expect, test } from "bun:test";
import {
  buildRelatedQuery,
  type RelatedHit,
  type RelatedInput,
  runClipRelated,
} from "./clip-related.ts";

const NO_ITEMS = (): null => null;
function hit(id: string, service = "github"): RelatedHit {
  return {
    id,
    title: id,
    service,
    type: "pr",
    snippet: "",
    url: `https://ex.com/${id}`,
    modified_at: 1,
  };
}

describe("buildRelatedQuery", () => {
  test("selection present → selection is the query", () => {
    expect(buildRelatedQuery({ title: "Docs", selection: "vector index" }, NO_ITEMS).query).toBe(
      "vector index",
    );
  });
  test("no selection → title is the query", () => {
    expect(buildRelatedQuery({ title: "Vector indexes" }, NO_ITEMS).query).toBe("Vector indexes");
  });
  test("canonicalUrl host is parsed into excludeHost", () => {
    expect(
      buildRelatedQuery({ title: "x", canonicalUrl: "https://ex.com/p" }, NO_ITEMS).excludeHost,
    ).toBe("ex.com");
  });
  test("empty inputs → empty query, no host", () => {
    const q = buildRelatedQuery({}, NO_ITEMS);
    expect(q.query).toBe("");
    expect(q.excludeHost).toBeUndefined();
  });
});

describe("buildRelatedQuery with itemId", () => {
  const lookup = (id: string): { title: string } | null =>
    id === "gh:1" ? { title: "Fix the flaky retry" } : null;

  test("itemId supplies the query text when there is no selection", () => {
    const q = buildRelatedQuery(
      { title: "Fix … · Pull Request #482 · acme/web", itemId: "gh:1" },
      lookup,
    );
    expect(q.query).toBe("Fix the flaky retry");
  });

  test("selection still beats itemId for the query text", () => {
    const q = buildRelatedQuery({ selection: "vector index", itemId: "gh:1" }, lookup);
    expect(q.query).toBe("vector index");
  });

  test("selection wins the query, and the item is STILL excluded", () => {
    const q = buildRelatedQuery({ selection: "vector index", itemId: "gh:1" }, lookup);
    expect(q.excludeId).toBe("gh:1");
  });

  test("an unknown itemId falls through to title rather than erroring", () => {
    const q = buildRelatedQuery({ title: "Page title", itemId: "gh:missing" }, lookup);
    expect(q.query).toBe("Page title");
    expect(q.excludeId).toBeUndefined();
  });

  test("no itemId → no exclusion", () => {
    expect(buildRelatedQuery({ title: "x" }, NO_ITEMS).excludeId).toBeUndefined();
  });

  test("a non-string itemId is coerced away, not thrown on", () => {
    const q = buildRelatedQuery({ title: "x", itemId: 7 } as unknown as RelatedInput, NO_ITEMS);
    expect(q.query).toBe("x");
    expect(q.excludeId).toBeUndefined();
  });
});

describe("runClipRelated", () => {
  test("delegates to the injected search and passes the built query", async () => {
    const calls: Array<{ query: string; limit: number }> = [];
    const out = await runClipRelated(
      {
        search: async (query, limit) => {
          calls.push({ query, limit });
          return [hit("drive:1", "drive")];
        },
        lookupItem: NO_ITEMS,
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
        lookupItem: NO_ITEMS,
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
        lookupItem: NO_ITEMS,
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
    const out = await runClipRelated({ search, lookupItem: NO_ITEMS }, {
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
    await runClipRelated({ search, lookupItem: NO_ITEMS }, {
      title: "hi",
      limit: "abc",
    } as unknown as RelatedInput);
    expect(seen).toEqual([10]);
  });

  test("null input → empty, no throw", async () => {
    const out = await runClipRelated(
      { search: async () => [], lookupItem: NO_ITEMS },
      null as unknown as RelatedInput,
    );
    expect(out.items).toEqual([]);
  });
});

describe("runClipRelated self-exclusion", () => {
  test("the item excludes itself from its own related list", async () => {
    const out = await runClipRelated(
      {
        search: async () => [hit("gh:1"), hit("gh:2")],
        lookupItem: (id) => (id === "gh:1" ? { title: "Fix the flaky retry" } : null),
      },
      { itemId: "gh:1" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["gh:2"]);
  });

  test("self-exclusion applies even when a selection drove the query", async () => {
    const out = await runClipRelated(
      {
        search: async () => [hit("gh:1"), hit("gh:2")],
        lookupItem: (id) => (id === "gh:1" ? { title: "Fix the flaky retry" } : null),
      },
      { selection: "flaky", itemId: "gh:1" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["gh:2"]);
  });

  test("a selection on an unresolved page searches normally and excludes nothing", async () => {
    const out = await runClipRelated(
      { search: async () => [hit("gh:1"), hit("gh:2")], lookupItem: NO_ITEMS },
      { selection: "flaky" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["gh:1", "gh:2"]);
  });
});
