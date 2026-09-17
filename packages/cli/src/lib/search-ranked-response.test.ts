import { describe, expect, test } from "bun:test";

import { parseSearchRankedResponse } from "./search-ranked-response.ts";

describe("parseSearchRankedResponse", () => {
  test("reads the envelope's rows and the gateway's own notes", () => {
    const r = parseSearchRankedResponse({
      items: [{ id: "a" }],
      retrieval: { vectorRanked: false, reason: "timeout", partial: null, backfill: null },
      notes: [
        "semantic ranking unavailable (the query embedding timed out) — keyword-only results",
      ],
    });
    expect(r.items).toEqual([{ id: "a" }]);
    expect(r.notes).toEqual([
      "semantic ranking unavailable (the query embedding timed out) — keyword-only results",
    ]);
  });

  test("a gateway that predates the envelope answers a bare array, which still parses", () => {
    expect(parseSearchRankedResponse([{ id: "a" }])).toEqual({ items: [{ id: "a" }], notes: [] });
  });

  test("malformed payloads yield no rows and no notes rather than throwing", () => {
    expect(parseSearchRankedResponse(null)).toEqual({ items: [], notes: [] });
    expect(parseSearchRankedResponse("x")).toEqual({ items: [], notes: [] });
    expect(parseSearchRankedResponse({ items: "nope", notes: [1, "", "kept"] })).toEqual({
      items: [],
      notes: ["kept"],
    });
  });
});
