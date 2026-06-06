import { describe, expect, test } from "bun:test";

import { mapHubspotDealToItem } from "../../../src/connectors/hubspot-deal-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function deal(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { properties: propsOver, ...rootOver } = over;
  return {
    id: "1001",
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-05-20T12:00:00Z",
    ...rootOver,
    properties: {
      dealname: "Acme Renewal 2026",
      amount: "42000",
      dealstage: "contractsent",
      pipeline: "default",
      closedate: "2026-06-30T00:00:00Z",
      createdate: "2026-01-02T00:00:00Z",
      hs_lastmodifieddate: "2026-05-20T12:00:00Z",
      ...(propsOver ?? {}),
    },
  };
}

describe("mapHubspotDealToItem", () => {
  test("maps a well-formed deal to a hubspot:deal item", () => {
    const row = mapHubspotDealToItem(deal(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("hubspot");
    expect(row.type).toBe("deal");
    expect(row.externalId).toBe("1001");
    expect(row.title).toBe("Acme Renewal 2026");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(row.syncedAt).toBe(SYNCED_AT);
    expect(row.metadata["dealstage"]).toBe("contractsent");
    expect(row.metadata["pipeline"]).toBe("default");
    expect(row.metadata["amount"]).toBe("42000");
    // hs_lastmodifieddate parses ISO → epoch-ms
    expect(row.metadata["hs_lastmodifieddate"]).toBe(Date.parse("2026-05-20T12:00:00Z"));
    expect(row.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00Z"));
  });

  test("parses epoch-millisecond date strings (HubSpot native encoding)", () => {
    const epochMs = "1748000000000";
    const row = mapHubspotDealToItem(
      deal({ properties: { hs_lastmodifieddate: epochMs, closedate: epochMs } }),
      { syncedAt: SYNCED_AT },
    );
    expect(row?.metadata["hs_lastmodifieddate"]).toBe(1_748_000_000_000);
    expect(row?.metadata["closedate"]).toBe(1_748_000_000_000);
    expect(row?.modifiedAt).toBe(1_748_000_000_000);
  });

  test("falls back to envelope updatedAt then syncedAt for modifiedAt", () => {
    const noLastMod = deal({ properties: { hs_lastmodifieddate: undefined } });
    delete (noLastMod["properties"] as Record<string, unknown>)["hs_lastmodifieddate"];
    const row = mapHubspotDealToItem(noLastMod, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00Z"));

    const noDates = deal();
    delete (noDates["properties"] as Record<string, unknown>)["hs_lastmodifieddate"];
    delete noDates["updatedAt"];
    const row2 = mapHubspotDealToItem(noDates, { syncedAt: SYNCED_AT });
    expect(row2?.modifiedAt).toBe(SYNCED_AT);
  });

  test("synthesizes a title when dealname is missing", () => {
    const noName = deal();
    delete (noName["properties"] as Record<string, unknown>)["dealname"];
    const row = mapHubspotDealToItem(noName, { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("HubSpot deal 1001");
    expect(row?.metadata["dealname"]).toBeNull();
  });

  test("returns null for a non-object input", () => {
    expect(mapHubspotDealToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapHubspotDealToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapHubspotDealToItem([], { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    expect(mapHubspotDealToItem(deal({ id: undefined }), { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapHubspotDealToItem(deal({ id: "" }), { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("tolerates a missing properties object", () => {
    const noProps = deal();
    delete noProps["properties"];
    const row = mapHubspotDealToItem(noProps, { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    expect(row?.title).toBe("HubSpot deal 1001");
    expect(row?.metadata["dealstage"]).toBeNull();
  });
});
