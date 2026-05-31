import { describe, expect, test } from "bun:test";

import { filterSalesforceOpportunities } from "../src/search-filter.ts";

function opportunity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: "0065g00000ABCDEAA1",
    Name: "Acme Renewal 2026",
    StageName: "Proposal/Price Quote",
    Amount: 42000,
    CloseDate: "2026-06-30",
    Type: "Existing Customer - Upgrade",
    IsClosed: false,
    IsWon: false,
    LastModifiedDate: "2026-05-20T12:00:00.000+0000",
    CreatedDate: "2026-01-02T00:00:00.000+0000",
    ...over,
  };
}

describe("filterSalesforceOpportunities", () => {
  test("matches against the opportunity name (case-insensitive)", () => {
    expect(filterSalesforceOpportunities([opportunity()], { query: "acme renewal" })).toHaveLength(
      1,
    );
  });

  test("matches against the stage name", () => {
    expect(
      filterSalesforceOpportunities([opportunity()], { query: "proposal/price" }),
    ).toHaveLength(1);
  });

  test("matches against the opportunity type", () => {
    expect(filterSalesforceOpportunities([opportunity()], { query: "upgrade" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterSalesforceOpportunities([opportunity()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries", () => {
    expect(
      filterSalesforceOpportunities([null, 42, "x", opportunity()], { query: "renewal" }),
    ).toHaveLength(1);
  });

  test("tolerates a missing Type", () => {
    const noType = opportunity();
    delete (noType as Record<string, unknown>)["Type"];
    // still matches on name
    expect(filterSalesforceOpportunities([noType], { query: "renewal" })).toHaveLength(1);
    // type-only query no longer matches
    expect(filterSalesforceOpportunities([noType], { query: "upgrade" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      opportunity({ Id: String(i), Name: "Renewal" }),
    );
    expect(filterSalesforceOpportunities(many, { query: "renewal", limit: 3 })).toHaveLength(3);
  });
});
