/**
 * Pure mapping from a Stripe `GET /v1/invoices` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `stripe-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "stripe", type = "invoice"` rows — a single item type.
 * `external_id = <invoice id>` (verbatim, e.g. `in_1A2b...`). The conceptual
 * item identity is `stripe:invoice`; the `item.id` ends up `stripe:<invoiceId>`.
 * The `invoice` type is sparse/structured (id, number, status, amounts,
 * customer id), so it stays on local MiniLM embeddings — NOT added to
 * `PROSE_HEAVY_TYPES`.
 *
 * IMPORTANT: Stripe timestamps (`created`, `due_date`, `period_start`,
 * `period_end`) are epoch SECONDS, NOT milliseconds. They are multiplied by
 * 1000 via {@link secondsToMs} on the way into the index — never passed through
 * verbatim (that is the Vercel/Databricks pattern for ms APIs — Stripe differs)
 * and never run through `Date.parse` (these are numbers, not ISO strings).
 *
 * Amounts (`amount_due`, `amount_paid`) are integer minor units (cents). The
 * body-preview fallback divides by 100 to render a human-readable figure;
 * zero-decimal currencies (e.g. JPY) are not special-cased in v1 — keeping
 * `/100` is acceptable and documented.
 */

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

/**
 * Convert a Stripe epoch-seconds field to epoch-ms. Returns `null` for missing,
 * non-finite, or `0` values (Stripe uses absent/null rather than 0 for unset
 * times, so treating 0 as "unknown" is safe and avoids a 1970 timestamp).
 */
export function secondsToMs(n: number | undefined): number | null {
  if (n === undefined || !Number.isFinite(n) || n === 0) {
    return null;
  }
  return n * 1000;
}

/**
 * Build the canonical (user-facing) URL for an invoice. Prefers the Stripe
 * hosted invoice page; else the PDF; else null.
 */
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

/** Human-readable amount, e.g. `12.50 USD`, from minor units + lowercase ISO currency. */
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
  // `customer` is the customer id string (Stripe expands to an object only when
  // explicitly requested — the default sync does not, so this is a bare id).
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

  // title: `Invoice <number> — <status>`; if number missing → `Invoice <id> — <status>`;
  // if status also missing → `Invoice <id>`.
  const label = number !== null && number !== "" ? number : id;
  const title =
    status !== null && status !== "" ? `Invoice ${label} — ${status}` : `Invoice ${label}`;

  // bodyPreview: description if present, else `<customer name||email> — <amount>`.
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
