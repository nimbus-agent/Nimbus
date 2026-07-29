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
      ...holderOver,
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

  // One row per card_holder field, each exercising the (p !== "") false arm in the .filter() for
  // that field: the surviving fields still match, and the deleted one no longer does.
  test.each([
    ["first_name", "Lovelace", "Ada"],
    ["last_name", "Ada", "Lovelace"],
    ["department_name", "Ada", "Engineering"],
  ])(
    "card_holder present but %s missing — still matches the remaining fields",
    (field, stillMatches, noLongerMatches) => {
      const row = txn();
      const holder = row["card_holder"] as Record<string, unknown>;
      delete holder[field];
      expect(filterRampTransactions([row], { query: stillMatches })).toHaveLength(1);
      expect(filterRampTransactions([row], { query: noLongerMatches })).toHaveLength(0);
    },
  );

  test("card_holder present with all name fields missing — cardHolderName returns empty string", () => {
    // All three filter(p !== "") arms produce false; cardHolderName contributes "" to the haystack
    const row = txn();
    const holder = row["card_holder"] as Record<string, unknown>;
    delete holder["first_name"];
    delete holder["last_name"];
    delete holder["department_name"];
    // Still matches on merchant_name
    expect(filterRampTransactions([row], { query: "amazon" })).toHaveLength(1);
    // No longer matches on any holder field
    expect(filterRampTransactions([row], { query: "Ada" })).toHaveLength(0);
    expect(filterRampTransactions([row], { query: "Engineering" })).toHaveLength(0);
  });

  test("card_holder present with non-string field values — stringField falls back to empty", () => {
    // first_name/last_name/department_name are numbers, not strings → stringField returns ""
    const row: Record<string, unknown> = {
      id: "txn_xyz",
      currency_code: "EUR",
      merchant_name: "Stripe",
      state: "PENDING",
      sk_category_name: "Payment",
      memo: "Subscription fee",
      card_holder: {
        first_name: 42,
        last_name: true,
        department_name: null,
      },
    };
    // Still matches on merchant_name
    expect(filterRampTransactions([row], { query: "stripe" })).toHaveLength(1);
    // None of the holder name searches match since fields are wrong type
    expect(filterRampTransactions([row], { query: "42" })).toHaveLength(0);
  });

  test("card_holder is a non-null non-plain-object (array) — treated as objectish, fields are empty", () => {
    // asObjectish accepts arrays (typeof [] === "object" && [] !== null)
    // so holder is defined, but first_name/last_name/department_name all undefined → stringField returns ""
    const row: Record<string, unknown> = {
      id: "txn_arr",
      currency_code: "GBP",
      merchant_name: "Acme Corp",
      state: "CLEARED",
      sk_category_name: "Office Supplies",
      memo: "Desk chair",
      card_holder: [],
    };
    expect(filterRampTransactions([row], { query: "acme" })).toHaveLength(1);
    expect(filterRampTransactions([row], { query: "Ada" })).toHaveLength(0);
  });

  test("top-level fields are wrong type — stringField returns empty for each", () => {
    // merchant_name, state, sk_category_name, currency_code, memo all set to non-string values
    const row: Record<string, unknown> = {
      id: "txn_badtypes",
      merchant_name: 9999,
      state: false,
      sk_category_name: { nested: true },
      currency_code: ["USD"],
      memo: null,
      card_holder: {
        first_name: "Bob",
        last_name: "Smith",
        department_name: "Finance",
      },
    };
    // Matches on holder fields since those are proper strings
    expect(filterRampTransactions([row], { query: "Bob Smith" })).toHaveLength(1);
    // Does NOT match on the wrong-type fields
    expect(filterRampTransactions([row], { query: "9999" })).toHaveLength(0);
    expect(filterRampTransactions([row], { query: "false" })).toHaveLength(0);
  });

  test("card_holder is a primitive (string) — asObjectish returns undefined, cardHolderName returns empty", () => {
    // asObjectish("Alice") → typeof "Alice" !== "object" → undefined → early return ""
    const row: Record<string, unknown> = {
      id: "txn_strHolder",
      currency_code: "USD",
      merchant_name: "Whole Foods",
      state: "CLEARED",
      sk_category_name: "Groceries",
      memo: "Team lunch",
      card_holder: "Alice Johnson",
    };
    expect(filterRampTransactions([row], { query: "whole foods" })).toHaveLength(1);
    // card_holder is a string, not an object → asObjectish → undefined → returns ""
    expect(filterRampTransactions([row], { query: "Alice Johnson" })).toHaveLength(0);
  });
});
