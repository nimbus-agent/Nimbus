import { describe, expect, test } from "bun:test";

import { filterCanvaDesigns } from "../src/search-filter.ts";

function design(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "DAFxyz123",
    title: "Q2 Marketing Deck",
    created_at: 1_735_776_000,
    updated_at: 1_747_699_200,
    urls: {
      edit_url: "https://www.canva.com/design/DAFxyz123/edit",
      view_url: "https://www.canva.com/design/DAFxyz123/view",
    },
    thumbnail: { url: "https://thumb.canva.com/DAFxyz123.png", width: 200, height: 120 },
    ...over,
  };
}

describe("filterCanvaDesigns", () => {
  test("matches against the design title (case-insensitive)", () => {
    expect(filterCanvaDesigns([design()], { query: "q2 marketing deck" })).toHaveLength(1);
    expect(filterCanvaDesigns([design()], { query: "MARKETING" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterCanvaDesigns([design()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries", () => {
    expect(filterCanvaDesigns([null, 42, "x", design()], { query: "marketing" })).toHaveLength(1);
  });

  test("tolerates a missing title", () => {
    const noTitle = design();
    delete noTitle["title"];
    expect(filterCanvaDesigns([noTitle], { query: "marketing" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      design({ id: String(i), title: "Marketing" }),
    );
    expect(filterCanvaDesigns(many, { query: "marketing", limit: 3 })).toHaveLength(3);
  });
});
