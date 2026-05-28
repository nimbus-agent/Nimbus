import { describe, expect, test } from "bun:test";

import {
  dashboardUrl,
  mapSupersetDashboardToItem,
} from "../../../src/connectors/superset-dashboard-mapping.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://superset.acme.com";

function makeDashboard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    dashboard_title: "Revenue Overview",
    slug: "revenue-overview",
    published: true,
    status: "published",
    owners: [{ id: 1 }, { id: 2 }],
    changed_by: { first_name: "Ada", last_name: "Lovelace" },
    changed_on_utc: "2022-06-01T08:00:00.000000+0000",
    created_on_delta_humanized: "2 years ago",
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapSupersetDashboardToItem>[1]> = {}) {
  return { baseUrl: BASE_URL, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapSupersetDashboardToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapSupersetDashboardToItem(null, ctx())).toBeNull();
    expect(mapSupersetDashboardToItem("nope", ctx())).toBeNull();
    expect(mapSupersetDashboardToItem(42, ctx())).toBeNull();
  });

  test("returns null when id is missing or non-numeric", () => {
    const noId = makeDashboard();
    delete noId["id"];
    expect(mapSupersetDashboardToItem(noId, ctx())).toBeNull();
    expect(mapSupersetDashboardToItem(makeDashboard({ id: "42" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is String(id)", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("superset");
    expect(row.type).toBe("dashboard");
    expect(row.externalId).toBe("42");
  });

  test("title is the dashboard_title; bodyPreview appends slug; url === canonicalUrl", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Revenue Overview");
    expect(row.bodyPreview).toBe("Revenue Overview (revenue-overview)");
    expect(row.url).toBe(row.canonicalUrl);
    expect(row.canonicalUrl).toBe("https://superset.acme.com/superset/dashboard/42/");
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("title falls back to `Dashboard <id>` when dashboard_title missing/empty; metadata.title stays null", () => {
    const noTitle = makeDashboard();
    delete noTitle["dashboard_title"];
    const a = mapSupersetDashboardToItem(noTitle, ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(a.title).toBe("Dashboard 42");
    expect(meta(a)["title"]).toBeNull();
    expect(a.bodyPreview).toBe("Dashboard 42 (revenue-overview)");

    const emptyTitle = mapSupersetDashboardToItem(makeDashboard({ dashboard_title: "" }), ctx());
    if (emptyTitle === null) throw new Error("expected mapping to succeed");
    expect(emptyTitle.title).toBe("Dashboard 42");
    expect(meta(emptyTitle)["title"]).toBeNull();
  });

  test("bodyPreview omits the slug suffix when slug is null/empty", () => {
    const row = mapSupersetDashboardToItem(makeDashboard({ slug: null }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Revenue Overview");
    expect(meta(row)["slug"]).toBeNull();

    const emptySlug = mapSupersetDashboardToItem(makeDashboard({ slug: "" }), ctx());
    if (emptySlug === null) throw new Error("expected mapping to succeed");
    expect(emptySlug.bodyPreview).toBe("Revenue Overview");
  });

  test("extracts flat fields into metadata", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["dashboard_id"]).toBe(42);
    expect(m["title"]).toBe("Revenue Overview");
    expect(m["slug"]).toBe("revenue-overview");
    expect(m["status"]).toBe("published");
  });

  test("published === true only when literally true", () => {
    const yes = mapSupersetDashboardToItem(makeDashboard({ published: true }), ctx());
    if (yes === null) throw new Error("expected mapping to succeed");
    expect(meta(yes)["published"]).toBe(true);

    const truthy = mapSupersetDashboardToItem(makeDashboard({ published: "yes" }), ctx());
    if (truthy === null) throw new Error("expected mapping to succeed");
    expect(meta(truthy)["published"]).toBe(false);

    const missing = makeDashboard();
    delete missing["published"];
    const none = mapSupersetDashboardToItem(missing, ctx());
    if (none === null) throw new Error("expected mapping to succeed");
    expect(meta(none)["published"]).toBe(false);
  });

  test("owner_count counts the owners array; 0 when absent / not an array", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["owner_count"]).toBe(2);

    const noOwners = makeDashboard();
    delete noOwners["owners"];
    const a = mapSupersetDashboardToItem(noOwners, ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["owner_count"]).toBe(0);

    const badOwners = mapSupersetDashboardToItem(makeDashboard({ owners: "nope" }), ctx());
    if (badOwners === null) throw new Error("expected mapping to succeed");
    expect(meta(badOwners)["owner_count"]).toBe(0);
  });

  test("changed_by flattens first + last name (trimmed); null when absent", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["changed_by"]).toBe("Ada Lovelace");

    const firstOnly = mapSupersetDashboardToItem(
      makeDashboard({ changed_by: { first_name: "Ada", last_name: "" } }),
      ctx(),
    );
    if (firstOnly === null) throw new Error("expected mapping to succeed");
    expect(meta(firstOnly)["changed_by"]).toBe("Ada");

    const noChangedBy = makeDashboard();
    delete noChangedBy["changed_by"];
    const none = mapSupersetDashboardToItem(noChangedBy, ctx());
    if (none === null) throw new Error("expected mapping to succeed");
    expect(meta(none)["changed_by"]).toBeNull();

    const emptyObj = mapSupersetDashboardToItem(makeDashboard({ changed_by: {} }), ctx());
    if (emptyObj === null) throw new Error("expected mapping to succeed");
    expect(meta(emptyObj)["changed_by"]).toBeNull();
  });

  test("changed_at parses changed_on_utc (ISO); modifiedAt mirrors it", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const expected = Date.parse("2022-06-01T08:00:00.000000+0000");
    expect(meta(row)["changed_at"]).toBe(expected);
    expect(row.modifiedAt).toBe(expected);
  });

  test("modifiedAt + changed_at fall back when changed_on_utc unparseable/missing", () => {
    const bad = mapSupersetDashboardToItem(makeDashboard({ changed_on_utc: "nope" }), ctx());
    if (bad === null) throw new Error("expected mapping to succeed");
    expect(meta(bad)["changed_at"]).toBeNull();
    expect(bad.modifiedAt).toBe(NOW);

    const missing = makeDashboard();
    delete missing["changed_on_utc"];
    const row = mapSupersetDashboardToItem(missing, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["changed_at"]).toBeNull();
    expect(row.modifiedAt).toBe(NOW);
  });

  test("syncedAt propagates", () => {
    const row = mapSupersetDashboardToItem(makeDashboard(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("dashboardUrl", () => {
  test("builds the dashboard page URL from the base", () => {
    expect(dashboardUrl("https://superset.acme.com", 42)).toBe(
      "https://superset.acme.com/superset/dashboard/42/",
    );
  });

  test("trims a trailing slash off the base", () => {
    expect(dashboardUrl("https://superset.acme.com/", 42)).toBe(
      "https://superset.acme.com/superset/dashboard/42/",
    );
  });
});
