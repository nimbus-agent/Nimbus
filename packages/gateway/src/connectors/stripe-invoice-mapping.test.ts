import { describe, expect, test } from "bun:test";

import { invoiceUrl, mapStripeInvoiceToItem, secondsToMs } from "./stripe-invoice-mapping.ts";

const ctx = { syncedAt: 777 };

describe("secondsToMs and invoiceUrl", () => {
  test("secondsToMs scales seconds and rejects absent, zero and non-finite values", () => {
    expect(secondsToMs(2)).toBe(2000);
    expect(secondsToMs(undefined)).toBeNull();
    expect(secondsToMs(0)).toBeNull();
    expect(secondsToMs(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("invoiceUrl prefers the hosted page, then the PDF, else null", () => {
    expect(invoiceUrl("https://h", "https://p")).toBe("https://h");
    expect(invoiceUrl("", "https://p")).toBe("https://p");
    expect(invoiceUrl(null, "https://p")).toBe("https://p");
    expect(invoiceUrl(null, "")).toBeNull();
    expect(invoiceUrl(null, null)).toBeNull();
  });
});

describe("mapStripeInvoiceToItem", () => {
  test("maps a full invoice", () => {
    const row = mapStripeInvoiceToItem(
      {
        id: "in_1",
        number: "INV-1",
        status: "paid",
        customer: "cus_1",
        customer_name: "Ada",
        customer_email: "a@x.io",
        amount_due: 12345,
        amount_paid: 12345,
        currency: "usd",
        subscription: "sub_1",
        hosted_invoice_url: "https://h",
        invoice_pdf: "https://p",
        created: 100,
        due_date: 200,
        period_start: 300,
        period_end: 400,
      },
      ctx,
    );
    expect(row?.title).toBe("Invoice INV-1 — paid");
    expect(row?.bodyPreview).toBe("Ada — 123.45 USD");
    expect(row?.url).toBe("https://h");
    expect(row?.modifiedAt).toBe(100_000);
    expect(row?.metadata).toMatchObject({
      due_date: 200_000,
      period_end: 400_000,
      subscription_id: "sub_1",
    });
  });

  test("falls back: id as label, email as who, a bare amount, the description as body", () => {
    const row = mapStripeInvoiceToItem(
      { id: "in_2", customer_email: "e@x.io", amount_due: 500 },
      ctx,
    );
    expect(row?.title).toBe("Invoice in_2");
    expect(row?.bodyPreview).toBe("e@x.io — 5.00");
    expect(row?.modifiedAt).toBe(777);
    expect(row?.metadata["due_date"]).toBeUndefined();
    const anonymous = mapStripeInvoiceToItem({ id: "in_3", currency: "eur" }, ctx);
    expect(anonymous?.bodyPreview).toBe("0.00 EUR");
    const described = mapStripeInvoiceToItem(
      { id: "in_4", description: "Consulting", status: "" },
      ctx,
    );
    expect(described?.bodyPreview).toBe("Consulting");
    expect(described?.title).toBe("Invoice in_4");
  });

  test.each([[null], [{}], [{ id: "" }]])("rejects %p", (raw) => {
    expect(mapStripeInvoiceToItem(raw, ctx)).toBeNull();
  });
});
