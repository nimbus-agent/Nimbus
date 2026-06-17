import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterPrefectDeployments } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["PREFECT_API_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("PREFECT_API_URL is not set");
  }
  return trimTrailingSlash(v);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Prefect Cloud requires a Bearer API key; self-hosted Prefect Server may run
  // keyless, so an empty key is tolerated (the header is simply omitted).
  const apiKey = process.env["PREFECT_API_KEY"]?.trim();
  if (apiKey !== undefined && apiKey !== "") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

async function prefectGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Prefect ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

async function prefectListDeployments(offset: number, limit: number): Promise<unknown> {
  const res = await fetch(`${apiBase()}/deployments/filter`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ limit, offset, sort: "CREATED_DESC" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Prefect ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function deploymentsFrom(root: unknown): unknown[] {
  return Array.isArray(root) ? root : [];
}

await runReadOnlyMcpConnector("nimbus-prefect", (reg) => {
  reg(
    "prefect_list",
    "List Prefect deployments (POST <api_url>/deployments/filter with a JSON body { limit, offset, sort: CREATED_DESC }). Prefect's list endpoints are POST-with-body filters, not GET query-string endpoints; the response is a bare JSON array of deployment objects. The optional offset arg (default 0) selects the page start; limit is fixed at 100.",
    z.object({
      offset: z.number().int().min(0).optional(),
    }),
    async (p) => {
      const offset = p.offset ?? 0;
      const root = await prefectListDeployments(offset, 100);
      return jsonResult({ items: deploymentsFrom(root) });
    },
  );

  reg(
    "prefect_get",
    "Fetch one Prefect deployment by its id (GET <api_url>/deployments/{id}). The id is the deployment UUID string. Returns the deployment object directly (NOT wrapped in an array). Throws when no deployment with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await prefectGet(`/deployments/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "prefect_search",
    "Substring search across the first page of Prefect deployments. Matches the query (case-insensitive) against the deployment name, description, work pool, work queue, status, and tags. Returns a matches envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await prefectListDeployments(0, 100);
      const matches = filterPrefectDeployments(deploymentsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
