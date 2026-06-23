import { describe, expect, test } from "bun:test";

import { type DataModelProfile, mapDataModelToItem } from "./data-profile-mapping.ts";

function profile(overrides: Partial<DataModelProfile> = {}): DataModelProfile {
  return {
    relativePath: "data/sales.csv",
    format: "csv",
    columns: [
      { name: "id", type: "number" },
      { name: "name", type: null },
    ],
    rowCountEstimate: 42,
    sizeBytes: 1024,
    modifiedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("mapDataModelToItem", () => {
  test("maps a basic profile to a dataprofile:data_model row (schema only)", () => {
    const row = mapDataModelToItem(profile(), { syncedAt: 999 });
    expect(row).not.toBeNull();
    expect(row?.service).toBe("dataprofile");
    expect(row?.type).toBe("data_model");
    expect(row?.externalId).toBe("data/sales.csv");
    expect(row?.title).toBe("sales.csv");
    expect(row?.modifiedAt).toBe(1_700_000_000_000);
    // no cell values — metadata carries column names/types + counts only
    expect(row?.metadata).toMatchObject({ columnCount: 2, rowCountEstimate: 42, sizeBytes: 1024 });
  });

  test("returns null for an empty / whitespace relativePath", () => {
    expect(mapDataModelToItem(profile({ relativePath: "   " }), { syncedAt: 1 })).toBeNull();
  });

  test("truncates an over-long title with an ellipsis (clamp truncation branch)", () => {
    const longName = `${"a".repeat(300)}.csv`;
    const row = mapDataModelToItem(profile({ relativePath: longName }), { syncedAt: 1 });
    expect(row?.title.endsWith("…")).toBe(true);
    expect(row?.title).toHaveLength(257); // 256 chars + the ellipsis
  });

  test("falls back to the full path when the basename is empty (trailing slash)", () => {
    const row = mapDataModelToItem(profile({ relativePath: "data/dir/" }), { syncedAt: 1 });
    expect(row?.title).toBe("data/dir/");
    expect(row?.externalId).toBe("data/dir/");
  });

  test("uses syncedAt as modifiedAt when modifiedAtMs is null", () => {
    const row = mapDataModelToItem(profile({ modifiedAtMs: null }), { syncedAt: 555 });
    expect(row?.modifiedAt).toBe(555);
  });
});
