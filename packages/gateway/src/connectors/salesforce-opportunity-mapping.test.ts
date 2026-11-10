import { describe, expect, test } from "bun:test";

import { mapSalesforceOpportunityToItem } from "./salesforce-opportunity-mapping.ts";

const ctx = { syncedAt: 9_000 };

describe("mapSalesforceOpportunityToItem", () => {
  test("maps every field of a full opportunity", () => {
    const row = mapSalesforceOpportunityToItem(
      {
        Id: "006X",
        Name: "Renewal",
        StageName: "Negotiation",
        Amount: 1234.5,
        CloseDate: "2026-06-01",
        Probability: 60,
        Type: "Existing",
        IsClosed: false,
        IsWon: true,
        LastModifiedDate: "2026-05-20T12:00:00.000Z",
        CreatedDate: "2026-01-01T00:00:00.000Z",
      },
      ctx,
    );
    expect(row?.externalId).toBe("006X");
    expect(row?.title).toBe("Renewal");
    expect(row?.bodyPreview).toBe("Renewal — Negotiation");
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00.000Z"));
    expect(row?.metadata).toMatchObject({
      amount: 1234.5,
      probability: 60,
      type: "Existing",
      isClosed: false,
      isWon: true,
      closeDate: "2026-06-01",
      createdDate: Date.parse("2026-01-01T00:00:00.000Z"),
    });
  });

  test("missing and wrongly typed fields are null; the title falls back to the id", () => {
    const row = mapSalesforceOpportunityToItem(
      { Id: "006Y", Name: "", Amount: "12", IsClosed: "yes", LastModifiedDate: "garbage" },
      ctx,
    );
    expect(row?.title).toBe("Salesforce opportunity 006Y");
    expect(row?.bodyPreview).toBe("Salesforce opportunity 006Y");
    expect(row?.modifiedAt).toBe(9_000);
    expect(row?.metadata["amount"]).toBeNull();
    expect(row?.metadata["isClosed"]).toBeNull();
    expect(row?.metadata["lastModifiedDate"]).toBeNull();
  });

  test("an empty stage adds no suffix", () => {
    const row = mapSalesforceOpportunityToItem({ Id: "1", Name: "N", StageName: "" }, ctx);
    expect(row?.bodyPreview).toBe("N");
  });

  test.each([[undefined], [[]], [{ Id: "" }], [{ Name: "x" }]])("rejects %p", (raw) => {
    expect(mapSalesforceOpportunityToItem(raw, ctx)).toBeNull();
  });
});
