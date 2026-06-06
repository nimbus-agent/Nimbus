import { describe, expect, test } from "bun:test";

import { filterStripeInvoices } from "../src/search-filter.ts";

function invoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_1A2b3C",
    number: "ABC-0001",
    status: "paid",
    customer: "cus_xyz",
    customer_name: "ACME Corp",
    customer_email: "billing@acme.com",
    description: "Monthly subscription — Pro plan",
    ...over,
  };
}

describe("filterStripeInvoices", () => {
  test("matches against invoice number (case-insensitive)", () => {
    expect(filterStripeInvoices([invoice()], { query: "abc-0001" })).toHaveLength(1);
  });

  test("matches against id, status, customer, name, email, and description", () => {
    expect(filterStripeInvoices([invoice()], { query: "in_1a2b" })).toHaveLength(1);
    expect(filterStripeInvoices([invoice()], { query: "paid" })).toHaveLength(1);
    expect(filterStripeInvoices([invoice()], { query: "cus_xyz" })).toHaveLength(1);
    expect(filterStripeInvoices([invoice()], { query: "acme corp" })).toHaveLength(1);
    expect(filterStripeInvoices([invoice()], { query: "billing@acme.com" })).toHaveLength(1);
    expect(filterStripeInvoices([invoice()], { query: "pro plan" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterStripeInvoices([invoice()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterStripeInvoices([null, 42, "x", invoice()], { query: "acme" })).toHaveLength(1);
  });

  test("tolerates missing string fields", () => {
    const sparse = invoice();
    delete sparse["description"];
    delete sparse["customer_name"];
    expect(filterStripeInvoices([sparse], { query: "abc-0001" })).toHaveLength(1);
    expect(filterStripeInvoices([sparse], { query: "pro plan" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => invoice({ id: `in_${String(i)}` }));
    expect(filterStripeInvoices(many, { query: "abc-0001", limit: 3 })).toHaveLength(3);
  });
});
