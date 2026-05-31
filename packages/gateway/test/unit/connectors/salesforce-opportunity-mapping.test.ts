import { describe, expect, test } from "bun:test";

import { mapSalesforceOpportunityToItem } from "../../../src/connectors/salesforce-opportunity-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function opportunity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: "0065g00000ABCDEAA1",
    Name: "Acme Renewal 2026",
    StageName: "Proposal/Price Quote",
    Amount: 42000,
    CloseDate: "2026-06-30",
    Probability: 60,
    Type: "Existing Customer - Upgrade",
    IsClosed: false,
    IsWon: false,
    LastModifiedDate: "2026-05-20T12:00:00.000+0000",
    CreatedDate: "2026-01-02T00:00:00.000+0000",
    ...over,
  };
}

describe("mapSalesforceOpportunityToItem", () => {
  test("maps a well-formed opportunity to a salesforce:opportunity item", () => {
    const row = mapSalesforceOpportunityToItem(opportunity(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("salesforce");
    expect(row.type).toBe("opportunity");
    expect(row.externalId).toBe("0065g00000ABCDEAA1");
    expect(row.title).toBe("Acme Renewal 2026");
    // Pure mapper: no instance host available, so url/canonical_url are null.
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(row.syncedAt).toBe(SYNCED_AT);
    expect(row.metadata["stage"]).toBe("Proposal/Price Quote");
    expect(row.metadata["amount"]).toBe(42000);
    expect(row.metadata["probability"]).toBe(60);
    expect(row.metadata["type"]).toBe("Existing Customer - Upgrade");
    expect(row.metadata["isClosed"]).toBe(false);
    expect(row.metadata["isWon"]).toBe(false);
    expect(row.metadata["closeDate"]).toBe("2026-06-30");
    // LastModifiedDate parses ISO → epoch-ms.
    expect(row.metadata["lastModifiedDate"]).toBe(Date.parse("2026-05-20T12:00:00.000+0000"));
    expect(row.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00.000+0000"));
  });

  test("falls back to syncedAt for modifiedAt when LastModifiedDate is absent", () => {
    const noMod = opportunity();
    delete noMod["LastModifiedDate"];
    const row = mapSalesforceOpportunityToItem(noMod, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(SYNCED_AT);
    expect(row?.metadata["lastModifiedDate"]).toBeNull();
  });

  test("synthesizes a title when Name is missing", () => {
    const noName = opportunity();
    delete noName["Name"];
    const row = mapSalesforceOpportunityToItem(noName, { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("Salesforce opportunity 0065g00000ABCDEAA1");
    expect(row?.metadata["name"]).toBeNull();
  });

  test("tolerates a missing Amount / Probability (non-number → null)", () => {
    const row = mapSalesforceOpportunityToItem(
      opportunity({ Amount: null, Probability: undefined }),
      { syncedAt: SYNCED_AT },
    );
    expect(row?.metadata["amount"]).toBeNull();
    expect(row?.metadata["probability"]).toBeNull();
  });

  test("returns null for a non-object input", () => {
    expect(mapSalesforceOpportunityToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapSalesforceOpportunityToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapSalesforceOpportunityToItem([], { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("returns null when Id is missing or empty", () => {
    expect(
      mapSalesforceOpportunityToItem(opportunity({ Id: undefined }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
    expect(
      mapSalesforceOpportunityToItem(opportunity({ Id: "" }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
  });
});
