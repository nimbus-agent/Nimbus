import { describe, expect, test } from "bun:test";

import { mapCanvaDesignToItem } from "../../../src/connectors/canva-design-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function design(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { urls: urlsOver, thumbnail: thumbOver, ...rootOver } = over;
  return {
    id: "DAFxyz123",
    title: "Q2 Marketing Deck",
    // Canva Connect design timestamps are Unix epoch SECONDS.
    created_at: 1_735_776_000,
    updated_at: 1_747_699_200,
    ...rootOver,
    urls: {
      edit_url: "https://www.canva.com/design/DAFxyz123/edit",
      view_url: "https://www.canva.com/design/DAFxyz123/view",
      ...(urlsOver ?? {}),
    },
    thumbnail: {
      url: "https://thumb.canva.com/DAFxyz123.png",
      width: 200,
      height: 120,
      ...(thumbOver ?? {}),
    },
  };
}

describe("mapCanvaDesignToItem", () => {
  test("maps a well-formed design to a canva:design item", () => {
    const row = mapCanvaDesignToItem(design(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("canva");
    expect(row.type).toBe("design");
    expect(row.externalId).toBe("DAFxyz123");
    expect(row.title).toBe("Q2 Marketing Deck");
    // Canonical url is the view url.
    expect(row.url).toBe("https://www.canva.com/design/DAFxyz123/view");
    expect(row.canonicalUrl).toBe("https://www.canva.com/design/DAFxyz123/view");
    expect(row.syncedAt).toBe(SYNCED_AT);
    expect(row.metadata["title"]).toBe("Q2 Marketing Deck");
    // Epoch seconds → milliseconds.
    expect(row.metadata["created_at"]).toBe(1_735_776_000 * 1000);
    expect(row.metadata["updated_at"]).toBe(1_747_699_200 * 1000);
    expect(row.metadata["edit_url"]).toBe("https://www.canva.com/design/DAFxyz123/edit");
    expect(row.metadata["view_url"]).toBe("https://www.canva.com/design/DAFxyz123/view");
    expect(row.metadata["thumbnail_url"]).toBe("https://thumb.canva.com/DAFxyz123.png");
    // modifiedAt prefers updated_at.
    expect(row.modifiedAt).toBe(1_747_699_200 * 1000);
  });

  test("tolerates ISO-8601 timestamp strings defensively", () => {
    const iso = design({ created_at: "2026-01-02T00:00:00Z", updated_at: "2026-05-20T12:00:00Z" });
    const row = mapCanvaDesignToItem(iso, { syncedAt: SYNCED_AT });
    expect(row?.metadata["created_at"]).toBe(Date.parse("2026-01-02T00:00:00Z"));
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00Z"));
  });

  test("falls back to created_at then syncedAt for modifiedAt", () => {
    const noUpdated = design();
    delete noUpdated["updated_at"];
    const row = mapCanvaDesignToItem(noUpdated, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(1_735_776_000 * 1000);

    const noDates = design();
    delete noDates["updated_at"];
    delete noDates["created_at"];
    const row2 = mapCanvaDesignToItem(noDates, { syncedAt: SYNCED_AT });
    expect(row2?.modifiedAt).toBe(SYNCED_AT);
  });

  test("synthesizes a title when title is missing", () => {
    const noTitle = design();
    delete noTitle["title"];
    const row = mapCanvaDesignToItem(noTitle, { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("Canva design DAFxyz123");
    expect(row?.metadata["title"]).toBeNull();
  });

  test("canonical url falls back to edit_url then null", () => {
    const noView = design();
    (noView["urls"] as Record<string, unknown>)["view_url"] = undefined;
    const row = mapCanvaDesignToItem(noView, { syncedAt: SYNCED_AT });
    expect(row?.url).toBe("https://www.canva.com/design/DAFxyz123/edit");

    const noUrls = design();
    delete noUrls["urls"];
    const row2 = mapCanvaDesignToItem(noUrls, { syncedAt: SYNCED_AT });
    expect(row2?.url).toBeNull();
    expect(row2?.canonicalUrl).toBeNull();
    expect(row2?.metadata["view_url"]).toBeNull();
  });

  test("returns null for a non-object input", () => {
    expect(mapCanvaDesignToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapCanvaDesignToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapCanvaDesignToItem([], { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    expect(mapCanvaDesignToItem(design({ id: undefined }), { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapCanvaDesignToItem(design({ id: "" }), { syncedAt: SYNCED_AT })).toBeNull();
  });
});
