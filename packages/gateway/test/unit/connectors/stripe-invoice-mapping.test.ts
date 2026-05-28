import { describe, expect, test } from "bun:test";

import {
  invoiceUrl,
  mapStripeInvoiceToItem,
  secondsToMs,
} from "../../../src/connectors/stripe-invoice-mapping.ts";

// 1_700_000_000 s = 2023-11-14T22:13:20Z → ×1000 = 1_700_000_000_000 ms.
const CREATED_S = 1_700_000_000;
const CREATED_MS = 1_700_000_000_000;
const DUE_S = 1_700_500_000;
const PERIOD_START_S = 1_699_000_000;
const PERIOD_END_S = 1_701_000_000;

function makeInvoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_1A2b3C",
    number: "ABC-0001",
    status: "paid",
    customer: "cus_xyz",
    customer_name: "ACME Corp",
    customer_email: "billing@acme.com",
    amount_due: 1250,
    amount_paid: 1250,
    currency: "usd",
    description: "Monthly subscription — Pro plan",
    subscription: "sub_123",
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/in_1A2b3C",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_1/in_1A2b3C/pdf",
    created: CREATED_S,
    due_date: DUE_S,
    period_start: PERIOD_START_S,
    period_end: PERIOD_END_S,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapStripeInvoiceToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapStripeInvoiceToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapStripeInvoiceToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapStripeInvoiceToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeInvoice();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapStripeInvoiceToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapStripeInvoiceToItem(makeInvoice({ id: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the verbatim invoice id", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("stripe");
    expect(row.type).toBe("invoice");
    expect(row.externalId).toBe("in_1A2b3C");
  });

  test("title is `Invoice <number> — <status>`", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Invoice ABC-0001 — paid");
  });

  test("title falls back to id when number missing", () => {
    const noNumber = makeInvoice();
    delete (noNumber as Record<string, unknown>)["number"];
    const row = mapStripeInvoiceToItem(noNumber, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Invoice in_1A2b3C — paid");
  });

  test("title is `Invoice <id>` when number and status both missing", () => {
    const bare = makeInvoice();
    delete (bare as Record<string, unknown>)["number"];
    delete (bare as Record<string, unknown>)["status"];
    const row = mapStripeInvoiceToItem(bare, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Invoice in_1A2b3C");
  });

  test("title drops the status clause when number present but status missing", () => {
    const noStatus = makeInvoice();
    delete (noStatus as Record<string, unknown>)["status"];
    const row = mapStripeInvoiceToItem(noStatus, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Invoice ABC-0001");
  });

  test("bodyPreview is the description when present", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Monthly subscription — Pro plan");
  });

  test("bodyPreview falls back to `<name> — <amount> <CUR>` when description missing", () => {
    const noDesc = makeInvoice();
    delete (noDesc as Record<string, unknown>)["description"];
    const row = mapStripeInvoiceToItem(noDesc, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("ACME Corp — 12.50 USD");
  });

  test("bodyPreview falls back to email when name missing, and amount-only when both absent", () => {
    const noName = makeInvoice();
    delete (noName as Record<string, unknown>)["description"];
    delete (noName as Record<string, unknown>)["customer_name"];
    const emailRow = mapStripeInvoiceToItem(noName, { syncedAt: NOW });
    if (emailRow === null) throw new Error("expected mapping to succeed");
    expect(emailRow.bodyPreview).toBe("billing@acme.com — 12.50 USD");

    const noCustomer = makeInvoice();
    delete (noCustomer as Record<string, unknown>)["description"];
    delete (noCustomer as Record<string, unknown>)["customer_name"];
    delete (noCustomer as Record<string, unknown>)["customer_email"];
    const amountOnly = mapStripeInvoiceToItem(noCustomer, { syncedAt: NOW });
    if (amountOnly === null) throw new Error("expected mapping to succeed");
    expect(amountOnly.bodyPreview).toBe("12.50 USD");
  });

  test("epoch-seconds → ms conversion: created_at === created * 1000", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["created_at"]).toBe(CREATED_S * 1000);
    expect(meta(row)["period_start"]).toBe(PERIOD_START_S * 1000);
    expect(meta(row)["period_end"]).toBe(PERIOD_END_S * 1000);
    expect(meta(row)["due_date"]).toBe(DUE_S * 1000);
  });

  test("modifiedAt is created (ms); falls back to syncedAt when created missing", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(CREATED_MS);

    const noCreated = makeInvoice();
    delete (noCreated as Record<string, unknown>)["created"];
    const fallback = mapStripeInvoiceToItem(noCreated, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
  });

  test("missing due_date → metadata due_date is undefined (omitted)", () => {
    const noDue = makeInvoice();
    delete (noDue as Record<string, unknown>)["due_date"];
    const row = mapStripeInvoiceToItem(noDue, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["due_date"]).toBeUndefined();
    expect("due_date" in meta(row)).toBe(true); // key present, value undefined
  });

  test("due_date of 0 (Stripe 'unset') maps to undefined", () => {
    const row = mapStripeInvoiceToItem(makeInvoice({ due_date: 0 }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["due_date"]).toBeUndefined();
  });

  test("canonicalUrl precedence: hosted > pdf > null", () => {
    const hosted = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (hosted === null) throw new Error("expected mapping to succeed");
    expect(hosted.canonicalUrl).toBe("https://invoice.stripe.com/i/acct_1/in_1A2b3C");
    expect(hosted.url).toBe(hosted.canonicalUrl);
    expect(meta(hosted)["canonical_url"]).toBe(hosted.canonicalUrl);

    const noHosted = makeInvoice();
    delete (noHosted as Record<string, unknown>)["hosted_invoice_url"];
    const pdf = mapStripeInvoiceToItem(noHosted, { syncedAt: NOW });
    if (pdf === null) throw new Error("expected mapping to succeed");
    expect(pdf.canonicalUrl).toBe("https://pay.stripe.com/invoice/acct_1/in_1A2b3C/pdf");

    const noUrls = makeInvoice();
    delete (noUrls as Record<string, unknown>)["hosted_invoice_url"];
    delete (noUrls as Record<string, unknown>)["invoice_pdf"];
    const none = mapStripeInvoiceToItem(noUrls, { syncedAt: NOW });
    if (none === null) throw new Error("expected mapping to succeed");
    expect(none.canonicalUrl).toBeNull();
    expect(none.url).toBeNull();
  });

  test("amount/currency body formatting renders minor units → major", () => {
    const noDesc = makeInvoice({ amount_due: 999, currency: "eur" });
    delete (noDesc as Record<string, unknown>)["description"];
    const row = mapStripeInvoiceToItem(noDesc, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("ACME Corp — 9.99 EUR");
  });

  test("missing customer fields are null-passthrough in metadata", () => {
    const sparse = makeInvoice();
    delete (sparse as Record<string, unknown>)["customer"];
    delete (sparse as Record<string, unknown>)["customer_name"];
    delete (sparse as Record<string, unknown>)["customer_email"];
    const row = mapStripeInvoiceToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["customer_id"]).toBeNull();
    expect(meta(row)["customer_name"]).toBeNull();
    expect(meta(row)["customer_email"]).toBeNull();
  });

  test("full metadata flows through", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["invoice_id"]).toBe("in_1A2b3C");
    expect(m["number"]).toBe("ABC-0001");
    expect(m["customer_id"]).toBe("cus_xyz");
    expect(m["status"]).toBe("paid");
    expect(m["amount_due"]).toBe(1250);
    expect(m["amount_paid"]).toBe(1250);
    expect(m["currency"]).toBe("usd");
    expect(m["subscription_id"]).toBe("sub_123");
    expect(m["hosted_invoice_url"]).toBe("https://invoice.stripe.com/i/acct_1/in_1A2b3C");
    expect(m["invoice_pdf"]).toBe("https://pay.stripe.com/invoice/acct_1/in_1A2b3C/pdf");
  });

  test("syncedAt propagates", () => {
    const row = mapStripeInvoiceToItem(makeInvoice(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("secondsToMs", () => {
  test("multiplies epoch seconds by 1000", () => {
    expect(secondsToMs(CREATED_S)).toBe(CREATED_MS);
  });

  test("returns null for undefined / non-finite / zero", () => {
    expect(secondsToMs(undefined)).toBeNull();
    expect(secondsToMs(Number.NaN)).toBeNull();
    expect(secondsToMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(secondsToMs(0)).toBeNull();
  });
});

describe("invoiceUrl", () => {
  test("prefers the hosted invoice URL", () => {
    expect(invoiceUrl("https://invoice.stripe.com/x", "https://pay.stripe.com/x/pdf")).toBe(
      "https://invoice.stripe.com/x",
    );
  });

  test("falls back to the PDF when hosted absent", () => {
    expect(invoiceUrl(null, "https://pay.stripe.com/x/pdf")).toBe("https://pay.stripe.com/x/pdf");
    expect(invoiceUrl("", "https://pay.stripe.com/x/pdf")).toBe("https://pay.stripe.com/x/pdf");
  });

  test("returns null when both inputs are empty", () => {
    expect(invoiceUrl(null, null)).toBeNull();
    expect(invoiceUrl("", "")).toBeNull();
  });
});
