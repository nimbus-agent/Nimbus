import { describe, expect, test } from "bun:test";

import { filterPipedriveDeals } from "../src/search-filter.ts";

function deal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12345,
    title: "Acme Corp — annual renewal",
    value: 48000,
    currency: "USD",
    status: "open",
    stage_id: 3,
    pipeline_id: 1,
    person_name: "Jane Roe",
    org_name: "Acme Corporation",
    owner_name: "Sam Seller",
    label: "hot-lead",
    add_time: "2024-01-15 10:30:00",
    update_time: "2024-02-01 08:00:00",
    ...over,
  };
}

describe("filterPipedriveDeals", () => {
  test("matches against the deal title (case-insensitive)", () => {
    expect(filterPipedriveDeals([deal()], { query: "annual renewal" })).toHaveLength(1);
    expect(filterPipedriveDeals([deal()], { query: "ACME CORP" })).toHaveLength(1);
  });

  test("matches against status, org_name, person_name, owner_name, and label", () => {
    expect(filterPipedriveDeals([deal()], { query: "open" })).toHaveLength(1);
    expect(filterPipedriveDeals([deal()], { query: "Acme Corporation" })).toHaveLength(1);
    expect(filterPipedriveDeals([deal()], { query: "Jane Roe" })).toHaveLength(1);
    expect(filterPipedriveDeals([deal()], { query: "Sam Seller" })).toHaveLength(1);
    expect(filterPipedriveDeals([deal()], { query: "hot-lead" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterPipedriveDeals([deal()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the currency or numeric value (not in the haystack)", () => {
    expect(filterPipedriveDeals([deal()], { query: "USD" })).toHaveLength(0);
    expect(filterPipedriveDeals([deal()], { query: "48000" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterPipedriveDeals([null, 42, "x", deal()], { query: "Acme" })).toHaveLength(1);
  });

  test("tolerates missing string fields", () => {
    const sparse = deal();
    delete sparse["org_name"];
    delete sparse["person_name"];
    delete sparse["label"];
    expect(filterPipedriveDeals([sparse], { query: "annual renewal" })).toHaveLength(1);
    expect(filterPipedriveDeals([sparse], { query: "Acme Corporation" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => deal({ id: i }));
    expect(filterPipedriveDeals(many, { query: "annual renewal", limit: 3 })).toHaveLength(3);
  });
});
