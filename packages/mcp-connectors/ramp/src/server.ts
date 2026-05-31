import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterRampTransactions } from "./search-filter.ts";

const BASE = "https://api.ramp.com";
const TOKEN_PATH = "/developer/v1/token";
const TOKEN_SCOPE = "transactions:read";

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set`);
  }
  return v;
}

let cachedToken: string | null = null;

async function token(): Promise<string> {
  if (cachedToken !== null) {
    return cachedToken;
  }
  const clientId = requiredEnv("RAMP_CLIENT_ID");
  const clientSecret = requiredEnv("RAMP_CLIENT_SECRET");
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: TOKEN_SCOPE });
  const res = await fetch(`${BASE}${TOKEN_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ramp token exchange ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  let parsed: { access_token?: unknown };
  try {
    parsed = JSON.parse(text) as { access_token?: unknown };
  } catch {
    throw new Error("Ramp token exchange: invalid JSON response");
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("Ramp token exchange: no access_token in response");
  }
  cachedToken = parsed.access_token;
  return cachedToken;
}

async function rampGet(path: string): Promise<unknown> {
  const t = await token();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ramp ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function transactionsFrom(root: unknown): unknown[] {
  const data = (root as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

await runReadOnlyMcpConnector("nimbus-ramp", (reg) => {
  reg(
    "ramp_list",
    "List Ramp card transactions (GET /developer/v1/transactions?page_size=N). The connector exchanges its OAuth2 client-credentials for a bearer token (POST /developer/v1/token, HTTP Basic auth, transactions:read scope) and caches it for the process. `limit` (default 100, max 100) caps page_size of the single first-page request. Returns the `.data` array — each transaction is { id, amount, currency_code, merchant_name, card_holder, state, sk_category_name, user_transaction_time, memo, ... }.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await rampGet(`/developer/v1/transactions?page_size=${String(p.limit ?? 100)}`);
      return jsonResult(transactionsFrom(root));
    },
  );

  reg(
    "ramp_get",
    "Fetch one Ramp transaction by its id (GET /developer/v1/transactions/{id}). Returns the transaction object directly. Throws when no transaction with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await rampGet(`/developer/v1/transactions/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "ramp_search",
    "Substring search across the first page of Ramp transactions. Matches the query (case-insensitive) against merchant name, category, state, currency, memo, and the card holder name/department. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await rampGet("/developer/v1/transactions?page_size=100");
      const matches = filterRampTransactions(transactionsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
