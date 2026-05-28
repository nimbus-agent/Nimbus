import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface StripeMappingContext {
  readonly syncedAt: number;
}

export interface StripeMappedRow {
  readonly service: "stripe";
  readonly type: "invoice";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export function secondsToMs(n: number | undefined): number | null {
  if (n === undefined || !Number.isFinite(n) || n === 0) {
    return null;
  }
  return n * 1000;
}

export function invoiceUrl(
  hostedInvoiceUrl: string | null,
  invoicePdf: string | null,
): string | null {
  if (hostedInvoiceUrl !== null && hostedInvoiceUrl !== "") {
    return hostedInvoiceUrl;
  }
  if (invoicePdf !== null && invoicePdf !== "") {
    return invoicePdf;
  }
  return null;
}

function formatAmount(amountMinor: number | null, currency: string | null): string {
  const major = ((amountMinor ?? 0) / 100).toFixed(2);
  const cur = (currency ?? "").toUpperCase();
  return cur === "" ? major : `${major} ${cur}`;
}

export function mapStripeInvoiceToItem(
  raw: unknown,
  ctx: StripeMappingContext,
): StripeMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const number = stringField(row, "number") ?? null;
  const status = stringField(row, "status") ?? null;
  const customerId = stringField(row, "customer") ?? null;
  const customerName = stringField(row, "customer_name") ?? null;
  const customerEmail = stringField(row, "customer_email") ?? null;
  const amountDue = numberField(row, "amount_due") ?? null;
  const amountPaid = numberField(row, "amount_paid") ?? null;
  const currency = stringField(row, "currency") ?? null;
  const description = stringField(row, "description") ?? null;
  const subscriptionId = stringField(row, "subscription") ?? null;
  const hostedInvoiceUrl = stringField(row, "hosted_invoice_url") ?? null;
  const invoicePdf = stringField(row, "invoice_pdf") ?? null;

  const createdAt = secondsToMs(numberField(row, "created"));
  const dueDate = secondsToMs(numberField(row, "due_date"));
  const periodStart = secondsToMs(numberField(row, "period_start"));
  const periodEnd = secondsToMs(numberField(row, "period_end"));

  const canonicalUrl = invoiceUrl(hostedInvoiceUrl, invoicePdf);

  const label = number !== null && number !== "" ? number : id;
  const title =
    status !== null && status !== "" ? `Invoice ${label} — ${status}` : `Invoice ${label}`;

  const who = customerName ?? customerEmail ?? "";
  const amountStr = formatAmount(amountDue, currency);
  const bodyPreview =
    description !== null && description !== ""
      ? description
      : who === ""
        ? amountStr
        : `${who} — ${amountStr}`;

  const modifiedAt = createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    invoice_id: id,
    number,
    customer_id: customerId,
    customer_name: customerName,
    customer_email: customerEmail,
    status,
    amount_due: amountDue,
    amount_paid: amountPaid,
    currency,
    subscription_id: subscriptionId,
    hosted_invoice_url: hostedInvoiceUrl,
    invoice_pdf: invoicePdf,
    created_at: createdAt,
    due_date: dueDate ?? undefined,
    period_start: periodStart,
    period_end: periodEnd,
    canonical_url: canonicalUrl,
  };

  return {
    service: "stripe",
    type: "invoice",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
