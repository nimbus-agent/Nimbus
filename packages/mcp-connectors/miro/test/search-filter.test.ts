import { describe, expect, test } from "bun:test";

import { filterMiroBoards } from "../src/search-filter.ts";

function board(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { owner: ownerOver, ...rootOver } = over;
  return {
    id: "3458764500000000000",
    name: "Q2 Roadmap",
    description: "Planning board for the next quarter",
    createdAt: "2026-01-02T00:00:00Z",
    modifiedAt: "2026-05-20T00:00:00Z",
    viewLink: "https://miro.com/app/board/3458764500000000000=/",
    ...rootOver,
    owner: {
      name: "Ada Lovelace",
      ...ownerOver,
    },
  };
}

describe("filterMiroBoards", () => {
  test("matches against the board name (case-insensitive)", () => {
    expect(filterMiroBoards([board()], { query: "q2 roadmap" })).toHaveLength(1);
  });

  test("matches against description and owner name", () => {
    expect(filterMiroBoards([board()], { query: "next quarter" })).toHaveLength(1);
    expect(filterMiroBoards([board()], { query: "ada lovelace" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMiroBoards([board()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries", () => {
    expect(filterMiroBoards([null, 42, "x", board()], { query: "roadmap" })).toHaveLength(1);
  });

  test("tolerates a missing owner object", () => {
    const noOwner = board();
    delete noOwner["owner"];
    // The board still matches on name even without an owner.
    expect(filterMiroBoards([noOwner], { query: "roadmap" })).toHaveLength(1);
    // An owner-only query no longer matches once the owner is gone.
    expect(filterMiroBoards([noOwner], { query: "ada" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => board({ id: String(i), name: "Roadmap" }));
    expect(filterMiroBoards(many, { query: "roadmap", limit: 3 })).toHaveLength(3);
  });
});
