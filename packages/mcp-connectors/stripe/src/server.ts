import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterStripeInvoices } from "./search-filter.ts";

const BASE = "https://api.stripe.com";

function apiKey(): string {
  const t = process.env["STRIPE_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("STRIPE_API_KEY is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiKey()}`, Accept: "application/json" };
}

async function stripeGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Stripe ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-stripe", (reg) => {
  reg(
    "stripe_list",
    "List recent Stripe invoices (`GET /v1/invoices`), most-recent-first, capped at `limit` (default 100). Returns the `{ object: 'list', data, has_more }` envelope.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
      return jsonResult(await stripeGet(`/v1/invoices?${search.toString()}`));
    },
  );

  reg(
    "stripe_get",
    "Fetch one Stripe invoice by its id (`GET /v1/invoices/{id}`, e.g. `in_1A2b...`). Returns the invoice object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await stripeGet(`/v1/invoices/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "stripe_search",
    "Substring search across recent Stripe invoices. Matches the query against id, number, status, customer id, customer name, customer email, and the description (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: "100" });
      const root = await stripeGet(`/v1/invoices?${search.toString()}`);
      const data = (root as { data?: unknown[] } | null)?.data;
      const matches = Array.isArray(data)
        ? filterStripeInvoices(data, { query: p.query, limit: p.limit })
        : [];
      return jsonResult({ matches });
    },
  );
});
