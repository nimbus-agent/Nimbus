import { describe, expect, test } from "bun:test";

import {
  dashboardUrl,
  mapMetabaseDashboardToItem,
} from "../../../src/connectors/metabase-dashboard-mapping.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://acme.metabaseapp.com";
const COLLECTION_NAMES: Record<string, string> = { "7": "Finance", root: "Our analytics" };

function makeDashboard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: "Revenue Overview",
    description: "Monthly revenue rollup",
    collection_id: 7,
    creator_id: 3,
    archived: false,
    created_at: "2021-02-10T20:03:11Z",
    updated_at: "2022-06-01T08:00:00Z",
    dashcards: [{ id: 1 }, { id: 2 }, { id: 3 }],
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapMetabaseDashboardToItem>[1]> = {}) {
  return { baseUrl: BASE_URL, collectionNames: COLLECTION_NAMES, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapMetabaseDashboardToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapMetabaseDashboardToItem(null, ctx())).toBeNull();
    expect(mapMetabaseDashboardToItem("nope", ctx())).toBeNull();
    expect(mapMetabaseDashboardToItem(42, ctx())).toBeNull();
  });

  test("returns null when id is missing or non-numeric", () => {
    const noId = makeDashboard();
    delete noId["id"];
    expect(mapMetabaseDashboardToItem(noId, ctx())).toBeNull();
    expect(mapMetabaseDashboardToItem(makeDashboard({ id: "42" }), ctx())).toBeNull();
  });

  test("returns null when name is missing or empty", () => {
    const noName = makeDashboard();
    delete noName["name"];
    expect(mapMetabaseDashboardToItem(noName, ctx())).toBeNull();
    expect(mapMetabaseDashboardToItem(makeDashboard({ name: "" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is String(id)", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("metabase");
    expect(row.type).toBe("dashboard");
    expect(row.externalId).toBe("42");
  });

  test("title is the name; bodyPreview is description; url === canonicalUrl", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Revenue Overview");
    expect(row.bodyPreview).toBe("Monthly revenue rollup");
    expect(row.url).toBe(row.canonicalUrl);
    expect(row.canonicalUrl).toBe("https://acme.metabaseapp.com/dashboard/42");
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("bodyPreview falls back to name when description absent", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard({ description: undefined }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Revenue Overview");
    expect(meta(row)["description"]).toBeNull();
  });

  test("extracts flat fields into metadata", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["dashboard_id"]).toBe(42);
    expect(m["name"]).toBe("Revenue Overview");
    expect(m["description"]).toBe("Monthly revenue rollup");
    expect(m["collection_id"]).toBe("7");
    expect(m["creator_id"]).toBe(3);
    expect(m["archived"]).toBe(false);
  });

  test("collection_name resolves from ctx.collectionNames keyed by String(collection_id)", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard({ collection_id: 7 }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["collection_name"]).toBe("Finance");
  });

  test('collection_id "root" resolves its name and keys as the string "root"', () => {
    const row = mapMetabaseDashboardToItem(makeDashboard({ collection_id: "root" }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["collection_id"]).toBe("root");
    expect(meta(row)["collection_name"]).toBe("Our analytics");
  });

  test("null collection_id → collection_id null + collection_name null", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard({ collection_id: null }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["collection_id"]).toBeNull();
    expect(meta(row)["collection_name"]).toBeNull();
  });

  test("unknown collection_id → collection_name null (not resolved)", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard({ collection_id: 999 }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["collection_id"]).toBe("999");
    expect(meta(row)["collection_name"]).toBeNull();
  });

  test("card_count counts dashcards when present", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["card_count"]).toBe(3);
  });

  test("card_count falls back to cards array, then null", () => {
    const withCards = makeDashboard();
    delete withCards["dashcards"];
    withCards["cards"] = [{ id: 1 }, { id: 2 }];
    const row = mapMetabaseDashboardToItem(withCards, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["card_count"]).toBe(2);

    const neither = makeDashboard();
    delete neither["dashcards"];
    const row2 = mapMetabaseDashboardToItem(neither, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["card_count"]).toBeNull();
  });

  test("archived === true only when literally true", () => {
    const archived = mapMetabaseDashboardToItem(makeDashboard({ archived: true }), ctx());
    if (archived === null) throw new Error("expected mapping to succeed");
    expect(meta(archived)["archived"]).toBe(true);

    const truthy = mapMetabaseDashboardToItem(makeDashboard({ archived: "yes" }), ctx());
    if (truthy === null) throw new Error("expected mapping to succeed");
    expect(meta(truthy)["archived"]).toBe(false);
  });

  test("created_at / updated_at parse ISO-8601; modifiedAt prefers updated_at", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(Date.parse("2021-02-10T20:03:11Z"));
    expect(meta(row)["updated_at"]).toBe(Date.parse("2022-06-01T08:00:00Z"));
    expect(row.modifiedAt).toBe(Date.parse("2022-06-01T08:00:00Z"));
  });

  test("modifiedAt falls back created_at → syncedAt when timestamps unparseable/missing", () => {
    const noUpdated = mapMetabaseDashboardToItem(makeDashboard({ updated_at: "nope" }), ctx());
    if (noUpdated === null) throw new Error("expected mapping to succeed");
    expect(meta(noUpdated)["updated_at"]).toBeNull();
    expect(noUpdated.modifiedAt).toBe(Date.parse("2021-02-10T20:03:11Z"));

    const bare = makeDashboard();
    delete bare["created_at"];
    delete bare["updated_at"];
    const row = mapMetabaseDashboardToItem(bare, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(meta(row)["updated_at"]).toBeNull();
    expect(row.modifiedAt).toBe(NOW);
  });

  test("syncedAt propagates", () => {
    const row = mapMetabaseDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("dashboardUrl", () => {
  test("builds the dashboard page URL from the base", () => {
    expect(dashboardUrl("https://acme.metabaseapp.com", 42)).toBe(
      "https://acme.metabaseapp.com/dashboard/42",
    );
  });

  test("trims a trailing slash off the base", () => {
    expect(dashboardUrl("https://acme.metabaseapp.com/", 42)).toBe(
      "https://acme.metabaseapp.com/dashboard/42",
    );
  });
});
