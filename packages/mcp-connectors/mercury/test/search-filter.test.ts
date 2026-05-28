import { describe, expect, test } from "bun:test";

import { filterMercuryAccounts } from "../src/search-filter.ts";

function account(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acct_1A2b3C",
    name: "Mercury Checking",
    status: "active",
    type: "mercury",
    kind: "checking",
    accountNumber: "9876543210",
    routingNumber: "021000021",
    legalBusinessName: "ACME Corp",
    ...over,
  };
}

describe("filterMercuryAccounts", () => {
  test("matches against account name (case-insensitive)", () => {
    expect(filterMercuryAccounts([account()], { query: "mercury checking" })).toHaveLength(1);
  });

  test("matches against id, status, type, kind, and legal business name", () => {
    expect(filterMercuryAccounts([account()], { query: "acct_1a2b" })).toHaveLength(1);
    expect(filterMercuryAccounts([account()], { query: "active" })).toHaveLength(1);
    expect(filterMercuryAccounts([account()], { query: "mercury" })).toHaveLength(1);
    expect(filterMercuryAccounts([account()], { query: "checking" })).toHaveLength(1);
    expect(filterMercuryAccounts([account()], { query: "acme corp" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMercuryAccounts([account()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the account number (not in the haystack)", () => {
    expect(filterMercuryAccounts([account()], { query: "9876543210" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterMercuryAccounts([null, 42, "x", account()], { query: "acme" })).toHaveLength(1);
  });

  test("tolerates missing string fields", () => {
    const sparse = account();
    delete (sparse as Record<string, unknown>)["legalBusinessName"];
    delete (sparse as Record<string, unknown>)["kind"];
    expect(filterMercuryAccounts([sparse], { query: "mercury checking" })).toHaveLength(1);
    expect(filterMercuryAccounts([sparse], { query: "acme corp" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => account({ id: `acct_${String(i)}` }));
    expect(filterMercuryAccounts(many, { query: "mercury checking", limit: 3 })).toHaveLength(3);
  });
});
