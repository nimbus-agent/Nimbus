import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterMercuryAccounts } from "./search-filter.ts";

const BASE = "https://api.mercury.com";

function apiToken(): string {
  const t = process.env["MERCURY_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("MERCURY_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function mercuryGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Mercury ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {
  reg(
    "mercury_list",
    "List the user's Mercury bank accounts (`GET /api/v1/accounts`). Returns the `{ accounts: [...] }` envelope. There is no pagination — Mercury returns the full account list in one call.",
    z.object({}),
    async () => {
      return jsonResult(await mercuryGet(`/api/v1/accounts`));
    },
  );

  reg(
    "mercury_get",
    "Fetch one Mercury account by its id (`GET /api/v1/account/{id}`, note the singular `account` in the path). Returns the account object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await mercuryGet(`/api/v1/account/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "mercury_search",
    "Substring search across the user's Mercury accounts. Matches the query against id, name, status, type, kind, and the legal business name (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await mercuryGet(`/api/v1/accounts`);
      const accounts = (root as { accounts?: unknown[] } | null)?.accounts;
      return matchesResult(accounts, filterMercuryAccounts, p);
    },
  );
});
