import { describe, expect, test } from "bun:test";

import {
  appBaseFromApiBase,
  featureUrl,
  mapFlagsmithFeatureToItem,
} from "../../../src/connectors/flagsmith-feature-mapping.ts";

const TAG_MAP: Record<number, string> = { 1: "checkout", 2: "frontend" };

function makeFeature(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "enable-new-checkout",
    type: "STANDARD",
    default_enabled: true,
    initial_value: "control",
    description: "Rolls out the redesigned checkout flow.",
    tags: [1, 2],
    is_archived: false,
    owners: [{ id: 10 }, { id: 11 }],
    created_date: "2021-02-10T20:03:11.000000Z",
    ...over,
  };
}

const NOW = 1_700_009_999_999;
const API_BASE = "https://api.flagsmith.com";

function ctx(over: Partial<Parameters<typeof mapFlagsmithFeatureToItem>[1]> = {}) {
  return {
    apiBase: API_BASE,
    projectId: 42,
    projectName: "payments",
    tagMap: TAG_MAP,
    syncedAt: NOW,
    ...over,
  };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapFlagsmithFeatureToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapFlagsmithFeatureToItem(null, ctx())).toBeNull();
    expect(mapFlagsmithFeatureToItem("nope", ctx())).toBeNull();
  });

  test("returns null when name is missing or empty", () => {
    const noName = makeFeature();
    delete (noName as Record<string, unknown>)["name"];
    expect(mapFlagsmithFeatureToItem(noName, ctx())).toBeNull();
    expect(mapFlagsmithFeatureToItem(makeFeature({ name: "" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is <projectId>:<name>", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("flagsmith");
    expect(row.type).toBe("feature_flag");
    expect(row.externalId).toBe("42:enable-new-checkout");
  });

  test("title is the name; bodyPreview from description, falls back to title", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("enable-new-checkout");
    expect(row.bodyPreview).toBe("Rolls out the redesigned checkout flow.");

    const noDesc = makeFeature();
    delete (noDesc as Record<string, unknown>)["description"];
    const row2 = mapFlagsmithFeatureToItem(noDesc, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.bodyPreview).toBe("enable-new-checkout");
  });

  test("type passes through any non-empty string; missing → null", () => {
    const standard = mapFlagsmithFeatureToItem(makeFeature({ type: "MULTIVARIATE" }), ctx());
    if (standard === null) throw new Error("expected mapping to succeed");
    expect(meta(standard)["type"]).toBe("MULTIVARIATE");

    // Unusual/unknown type strings are NOT rejected (deliberate departure
    // from LD's enum-restricted kind).
    const weird = mapFlagsmithFeatureToItem(makeFeature({ type: "SOME_FUTURE_TYPE" }), ctx());
    if (weird === null) throw new Error("expected mapping to succeed");
    expect(meta(weird)["type"]).toBe("SOME_FUTURE_TYPE");

    const noType = makeFeature();
    delete (noType as Record<string, unknown>)["type"];
    const missing = mapFlagsmithFeatureToItem(noType, ctx());
    if (missing === null) throw new Error("expected mapping to succeed");
    expect(meta(missing)["type"]).toBeNull();
  });

  test("default_enabled / is_archived are strict boolean reads", () => {
    const row = mapFlagsmithFeatureToItem(
      makeFeature({ default_enabled: "true", is_archived: 1 }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["default_enabled"]).toBe(false);
    expect(meta(row)["is_archived"]).toBe(false);

    const truthy = mapFlagsmithFeatureToItem(
      makeFeature({ default_enabled: true, is_archived: true }),
      ctx(),
    );
    if (truthy === null) throw new Error("expected mapping to succeed");
    expect(meta(truthy)["default_enabled"]).toBe(true);
    expect(meta(truthy)["is_archived"]).toBe(true);
  });

  test("tags resolve to labels (sorted); unresolved / non-number ids dropped", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature({ tags: [2, 1, 999, "x"] }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["checkout", "frontend"]);

    const noTags = mapFlagsmithFeatureToItem(makeFeature({ tags: undefined }), ctx());
    if (noTags === null) throw new Error("expected mapping to succeed");
    expect(meta(noTags)["tags"]).toEqual([]);
  });

  test("owner_count counts the owners array; defaults to 0", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["owner_count"]).toBe(2);

    const noOwners = makeFeature();
    delete (noOwners as Record<string, unknown>)["owners"];
    const row2 = mapFlagsmithFeatureToItem(noOwners, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["owner_count"]).toBe(0);
  });

  test("initial_value + project metadata flow through", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["initial_value"]).toBe("control");
    expect(m["project_id"]).toBe(42);
    expect(m["project_name"]).toBe("payments");
  });

  test("created_at parses ISO-8601; modifiedAt uses it", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const expectedMs = Date.parse("2021-02-10T20:03:11.000000Z");
    expect(meta(row)["created_at"]).toBe(expectedMs);
    expect(row.modifiedAt).toBe(expectedMs);
  });

  test("unparseable created_date → created_at null; modifiedAt falls back to syncedAt", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature({ created_date: "not-a-date" }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(row.modifiedAt).toBe(NOW);

    const noDate = makeFeature();
    delete (noDate as Record<string, unknown>)["created_date"];
    const row2 = mapFlagsmithFeatureToItem(noDate, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["created_at"]).toBeNull();
    expect(row2.modifiedAt).toBe(NOW);
  });

  test("canonical url points at the project page; url === canonicalUrl", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://app.flagsmith.com/project/42");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("syncedAt propagates", () => {
    const row = mapFlagsmithFeatureToItem(makeFeature(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("appBaseFromApiBase", () => {
  test("rewrites a leading api. to app.", () => {
    expect(appBaseFromApiBase("https://api.flagsmith.com")).toBe("https://app.flagsmith.com");
  });

  test("passes a self-hosted host through unchanged", () => {
    expect(appBaseFromApiBase("https://flagsmith.internal.example.com")).toBe(
      "https://flagsmith.internal.example.com",
    );
  });

  test("preserves a non-standard port", () => {
    expect(appBaseFromApiBase("http://api.flagsmith.local:8080")).toBe(
      "http://app.flagsmith.local:8080",
    );
  });

  test("falls back to the SaaS app host on parse failure", () => {
    expect(appBaseFromApiBase("not a url")).toBe("https://app.flagsmith.com");
  });
});

describe("featureUrl", () => {
  test("builds the project page URL from the api base", () => {
    expect(featureUrl("https://api.flagsmith.com", 7)).toBe("https://app.flagsmith.com/project/7");
  });
});
