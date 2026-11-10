import { describe, expect, test } from "bun:test";

import { mapHubspotDealToItem } from "./hubspot-deal-mapping.ts";

const ctx = { syncedAt: 5_000 };

describe("mapHubspotDealToItem", () => {
  test("maps a deal with epoch-ms string and ISO date properties", () => {
    const row = mapHubspotDealToItem(
      {
        id: "42",
        properties: {
          dealname: "Big deal",
          amount: "1000",
          dealstage: "closedwon",
          pipeline: "default",
          closedate: "2026-05-20T12:00:00.000Z",
          createdate: "1700000000000",
          hs_lastmodifieddate: 1_700_000_001_000,
        },
      },
      ctx,
    );
    expect(row?.externalId).toBe("42");
    expect(row?.title).toBe("Big deal");
    expect(row?.bodyPreview).toBe("Big deal — closedwon");
    expect(row?.modifiedAt).toBe(1_700_000_001_000);
    expect(row?.metadata["closedate"]).toBe(Date.parse("2026-05-20T12:00:00.000Z"));
    expect(row?.metadata["createdate"]).toBe(1_700_000_000_000);
    expect(row?.url).toBeNull();
  });

  test("unparseable dates become null and modifiedAt falls back to the envelope, then syncedAt", () => {
    const withEnvelope = mapHubspotDealToItem(
      {
        id: "1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        properties: { closedate: "not a date", createdate: Number.NaN, hs_lastmodifieddate: "" },
      },
      ctx,
    );
    expect(withEnvelope?.metadata["closedate"]).toBeNull();
    expect(withEnvelope?.metadata["createdate"]).toBeNull();
    expect(withEnvelope?.modifiedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    const bare = mapHubspotDealToItem({ id: "2", updatedAt: {} }, ctx);
    expect(bare?.modifiedAt).toBe(5_000);
  });

  test("a deal without a name is titled by its id and has no stage suffix", () => {
    const row = mapHubspotDealToItem({ id: "7", properties: { dealname: "", dealstage: "" } }, ctx);
    expect(row?.title).toBe("HubSpot deal 7");
    expect(row?.bodyPreview).toBe("HubSpot deal 7");
  });

  test("an all-digit string that overflows to infinity is not a date", () => {
    const row = mapHubspotDealToItem({ id: "8", properties: { closedate: "9".repeat(400) } }, ctx);
    expect(row?.metadata["closedate"]).toBeNull();
  });

  test.each([[null], ["x"], [{}], [{ id: "" }], [{ id: 5 }]])("rejects %p", (raw) => {
    expect(mapHubspotDealToItem(raw, ctx)).toBeNull();
  });
});
