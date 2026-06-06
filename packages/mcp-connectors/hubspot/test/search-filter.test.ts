import { describe, expect, test } from "bun:test";

import { filterHubspotDeals } from "../src/search-filter.ts";

function deal(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { properties: propsOver, ...rootOver } = over;
  return {
    id: "1001",
    ...rootOver,
    properties: {
      dealname: "Acme Renewal 2026",
      amount: "42000",
      dealstage: "contractsent",
      pipeline: "default",
      closedate: "2026-06-30T00:00:00Z",
      createdate: "2026-01-02T00:00:00Z",
      hs_lastmodifieddate: "2026-05-20T00:00:00Z",
      ...(propsOver ?? {}),
    },
  };
}

describe("filterHubspotDeals", () => {
  test("matches against the deal name (case-insensitive)", () => {
    expect(filterHubspotDeals([deal()], { query: "acme renewal" })).toHaveLength(1);
  });

  test("matches against deal stage and pipeline", () => {
    expect(filterHubspotDeals([deal()], { query: "contractsent" })).toHaveLength(1);
    expect(filterHubspotDeals([deal()], { query: "default" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterHubspotDeals([deal()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries", () => {
    expect(filterHubspotDeals([null, 42, "x", deal()], { query: "acme" })).toHaveLength(1);
  });

  test("tolerates a missing properties object", () => {
    const noProps = deal();
    delete noProps["properties"];
    expect(filterHubspotDeals([noProps], { query: "acme" })).toHaveLength(0);
    // A row with no properties still does not throw.
    expect(filterHubspotDeals([noProps, deal()], { query: "acme" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      deal({ id: String(i), properties: { dealname: "Acme deal" } }),
    );
    expect(filterHubspotDeals(many, { query: "acme", limit: 3 })).toHaveLength(3);
  });
});
