import { describe, expect, test } from "bun:test";

import { filterRampTransactions } from "../src/search-filter.ts";

function txn(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { card_holder: holderOver, ...rootOver } = over;
  return {
    id: "txn_abc123",
    amount: 4212.55,
    currency_code: "USD",
    merchant_name: "Amazon Web Services",
    state: "CLEARED",
    sk_category_name: "Cloud Computing",
    memo: "Monthly AWS production bill",
    user_transaction_time: "2024-03-02T08:00:00Z",
    ...rootOver,
    card_holder: {
      first_name: "Ada",
      last_name: "Lovelace",
      department_name: "Engineering",
      ...(holderOver ?? {}),
    },
  };
}

describe("filterRampTransactions", () => {
  test("matches against the merchant name (case-insensitive)", () => {
    expect(filterRampTransactions([txn()], { query: "amazon web services" })).toHaveLength(1);
  });

  test("matches against category, state, currency, memo, holder name, and department", () => {
    expect(filterRampTransactions([txn()], { query: "Cloud Computing" })).toHaveLength(1);
    expect(filterRampTransactions([txn()], { query: "CLEARED" })).toHaveLength(1);
    expect(filterRampTransactions([txn()], { query: "USD" })).toHaveLength(1);
    expect(filterRampTransactions([txn()], { query: "production bill" })).toHaveLength(1);
    expect(filterRampTransactions([txn()], { query: "Ada Lovelace" })).toHaveLength(1);
    expect(filterRampTransactions([txn()], { query: "Engineering" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterRampTransactions([txn()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-objectish entries", () => {
    expect(filterRampTransactions([null, 42, "x", txn()], { query: "amazon" })).toHaveLength(1);
  });

  test("tolerates a missing card_holder object", () => {
    const noHolder = txn();
    delete noHolder["card_holder"];
    expect(filterRampTransactions([noHolder], { query: "amazon" })).toHaveLength(1);
    expect(filterRampTransactions([noHolder], { query: "Ada Lovelace" })).toHaveLength(0);
  });

  test("tolerates missing optional string fields", () => {
    const sparse = txn();
    delete sparse["memo"];
    delete sparse["sk_category_name"];
    expect(filterRampTransactions([sparse], { query: "amazon" })).toHaveLength(1);
    expect(filterRampTransactions([sparse], { query: "production bill" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => txn({ id: `txn_${String(i)}` }));
    expect(filterRampTransactions(many, { query: "amazon", limit: 3 })).toHaveLength(3);
  });
});
