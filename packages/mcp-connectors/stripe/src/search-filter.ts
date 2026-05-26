/**
 * Pure substring-match filter for `stripe_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * number/status/customer/description haystack + case-insensitive substring
 * match.
 */

export interface StripeSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const id = stringField(row, "id");
  const number = stringField(row, "number");
  const status = stringField(row, "status");
  const customer = stringField(row, "customer");
  const customerName = stringField(row, "customer_name");
  const customerEmail = stringField(row, "customer_email");
  const description = stringField(row, "description");
  return `${id} ${number} ${status} ${customer} ${customerName} ${customerEmail} ${description}`.toLowerCase();
}

export function filterStripeInvoices(
  invoices: readonly unknown[],
  options: StripeSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of invoices) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    if (!buildHaystack(row).includes(needle)) {
      continue;
    }
    out.push(it);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}
