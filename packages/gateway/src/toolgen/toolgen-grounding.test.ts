import { describe, expect, test } from "bun:test";
import type { RankedIndexItem } from "../index/ranked-item.ts";
import type { SearchRankedResult } from "../index/search-retrieval.ts";
import { createEndpointFinder, groundingOf } from "./toolgen-grounding.ts";

function rankedItem(title: string, meta: Record<string, unknown>): RankedIndexItem {
  return {
    id: title,
    service: "openapi",
    itemType: "api_endpoint",
    name: title,
    rawMeta: meta,
    score: 1,
    indexPrimaryKey: title,
    indexedType: "api_endpoint",
  } as unknown as RankedIndexItem;
}

/** A search result as `searchRankedAsync` returns it, for mocks that only care about the items. */
function found(items: RankedIndexItem[]): SearchRankedResult {
  return {
    items,
    retrieval: { vectorRanked: false, reason: "no_query", partial: null, backfill: null },
  };
}

describe("createEndpointFinder", () => {
  test("queries api_endpoint items with the description as the search term", async () => {
    const calls: unknown[] = [];
    const index = {
      searchRankedAsync: async (q: unknown) => {
        calls.push(q);
        return found([
          rankedItem("GET /repos/{owner}/{repo}/issues", {
            service_name: "github-api",
            operation_id: "listIssues",
            tags: ["issues"],
          }),
        ]);
      },
    };
    const find = createEndpointFinder(index as never);
    const out = await find("list issues in a repo", 8);

    expect(calls[0]).toEqual({ itemType: "api_endpoint", name: "list issues in a repo", limit: 8 });
    expect(out).toEqual([
      {
        serviceName: "github-api",
        method: "GET",
        path: "/repos/{owner}/{repo}/issues",
        operationId: "listIssues",
        summary: "issues",
      },
    ]);
  });

  test("skips an item whose title is not METHOD PATH rather than emitting a broken row", async () => {
    const index = { searchRankedAsync: async () => found([rankedItem("malformed", {})]) };
    expect(await createEndpointFinder(index as never)("q", 8)).toEqual([]);
  });

  test("AsyncAPI channels are deliberately excluded: a generated tool has no pub/sub transport", async () => {
    const index = {
      searchRankedAsync: async () =>
        found([
          rankedItem("PUBLISH user/signedup", { service_name: "kafka", tags: ["user"] }),
          rankedItem("SUBSCRIBE user/signedup", { service_name: "kafka", tags: ["user"] }),
        ]),
    };
    expect(await createEndpointFinder(index as never)("q", 8)).toEqual([]);
  });

  test("an index error yields no grounding rather than failing the draft", async () => {
    const index = {
      searchRankedAsync: async () => {
        throw new Error("index unavailable");
      },
    };
    expect(await createEndpointFinder(index as never)("q", 8)).toEqual([]);
  });

  test("an item with no rawMeta at all falls back to item.service, null operationId, empty summary", async () => {
    // `rawMeta` is optional on NimbusItem — a real indexed item can carry none.
    const item = {
      id: "GET /health",
      service: "internal-api",
      itemType: "api_endpoint",
      name: "GET /health",
      score: 1,
      indexPrimaryKey: "GET /health",
      indexedType: "api_endpoint",
      // rawMeta intentionally absent
    } as unknown as RankedIndexItem;
    const index = { searchRankedAsync: async () => found([item]) };
    expect(await createEndpointFinder(index as never)("q", 8)).toEqual([
      {
        serviceName: "internal-api",
        method: "GET",
        path: "/health",
        operationId: null,
        summary: "",
      },
    ]);
  });

  test("rawMeta.tags absent or not an array falls back to an empty summary, not a throw", async () => {
    const index = {
      searchRankedAsync: async () =>
        found([
          rankedItem("GET /a", { service_name: "svc", tags: "not-an-array" }),
          rankedItem("GET /b", {}),
        ]),
    };
    const out = await createEndpointFinder(index as never)("q", 8);
    expect(out.map((e) => e.summary)).toEqual(["", ""]);
  });

  test("non-string entries in rawMeta.tags are filtered out of the summary", async () => {
    const index = {
      searchRankedAsync: async () =>
        found([rankedItem("GET /a", { service_name: "svc", tags: ["issues", 42, null, "open"] })]),
    };
    const out = await createEndpointFinder(index as never)("q", 8);
    expect(out[0]?.summary).toBe("issues open");
  });

  test("a wrong-typed service_name falls back to item.service rather than the bad value", async () => {
    const index = {
      searchRankedAsync: async () => found([rankedItem("GET /a", { service_name: 12345 })]),
    };
    const out = await createEndpointFinder(index as never)("q", 8);
    expect(out[0]?.serviceName).toBe("openapi"); // rankedItem()'s item.service
  });

  test("a wrong-typed operation_id falls back to null rather than the bad value", async () => {
    const index = {
      searchRankedAsync: async () => found([rankedItem("GET /a", { operation_id: 999 })]),
    };
    const out = await createEndpointFinder(index as never)("q", 8);
    expect(out[0]?.operationId).toBeNull();
  });
});

describe("groundingOf", () => {
  test("reports description_only for an empty result", () => {
    expect(groundingOf([])).toEqual({ kind: "description_only" });
  });

  test("reports a count and DEDUPLICATED service names", () => {
    const ep = (serviceName: string) => ({
      serviceName,
      method: "GET",
      path: "/x",
      operationId: null,
      summary: "",
    });
    expect(groundingOf([ep("a"), ep("a"), ep("b")])).toEqual({
      kind: "endpoints",
      count: 3,
      services: ["a", "b"],
    });
  });

  test("sorts services presented out of order (exercises the descending comparator branch)", () => {
    const ep = (serviceName: string) => ({
      serviceName,
      method: "GET",
      path: "/x",
      operationId: null,
      summary: "",
    });
    // Fed in reverse alphabetical order: the comparator must return the > branch (1) to sort
    // these back into order, not just the < branch a same-order input would exercise.
    const grounding = groundingOf([ep("c"), ep("b"), ep("a")]);
    expect(grounding.kind).toBe("endpoints");
    if (grounding.kind === "endpoints") {
      expect(grounding.services).toEqual(["a", "b", "c"]);
    }
  });
});
