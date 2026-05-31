import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterDbtJobs } from "./search-filter.ts";

const DEFAULT_API_BASE = "https://cloud.getdbt.com";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["DBT_API_BASE"]?.trim();
  return v === undefined || v === "" ? DEFAULT_API_BASE : trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const t = process.env["DBT_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("DBT_TOKEN is not set");
  }
  return { Authorization: `Token ${t}`, Accept: "application/json" };
}

async function dbtGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}/api/v2${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`dbt Cloud ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function dataFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const data = (root as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

await runReadOnlyMcpConnector("nimbus-dbt", (reg) => {
  reg(
    "dbt_list",
    "List dbt Cloud accounts, or jobs for an account. Without `accountId`, returns the account's accounts (`/accounts/`). With `accountId`, returns that account's jobs (`/accounts/{accountId}/jobs/`), capped at `limit` (default 100). Returns the raw dbt Cloud envelope (`{ data: [...] }`).",
    z.object({
      accountId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.accountId === undefined) {
        return jsonResult(await dbtGet("/accounts/"));
      }
      const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
      return jsonResult(
        await dbtGet(
          `/accounts/${encodeURIComponent(String(p.accountId))}/jobs/?${search.toString()}`,
        ),
      );
    },
  );

  reg(
    "dbt_get",
    "Fetch one dbt Cloud job by `accountId` + `jobId` (`/accounts/{accountId}/jobs/{jobId}/`). Returns the raw dbt Cloud envelope. Throws when no such job exists.",
    z.object({
      accountId: z.number().int(),
      jobId: z.number().int(),
    }),
    async (p) => {
      return jsonResult(
        await dbtGet(
          `/accounts/${encodeURIComponent(String(p.accountId))}/jobs/${encodeURIComponent(String(p.jobId))}/`,
        ),
      );
    },
  );

  reg(
    "dbt_search",
    "Substring search across an account's dbt Cloud jobs. Matches the query against job name, dbt version, and id (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      accountId: z.number().int(),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ limit: "500" });
      const root = await dbtGet(
        `/accounts/${encodeURIComponent(String(p.accountId))}/jobs/?${search.toString()}`,
      );
      const matches = filterDbtJobs(dataFrom(root), { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
