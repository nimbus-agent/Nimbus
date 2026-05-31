import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterHubspotDeals } from "./search-filter.ts";

const BASE = "https://api.hubapi.com";
const DEAL_PROPERTIES =
  "dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate";

function apiToken(): string {
  const t = process.env["HUBSPOT_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("HUBSPOT_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function hubspotGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HubSpot ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function dealsFrom(root: unknown): unknown[] {
  const results = (root as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

await runReadOnlyMcpConnector("nimbus-hubspot", (reg) => {
  reg(
    "hubspot_list",
    "List the authenticated portal's HubSpot deals (GET /crm/v3/objects/deals?limit=N&properties=dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate). Returns the { results: [...], paging?: { next?: { after } } } envelope — `results` holds the deal objects, each shaped { id, properties: { dealname, amount, dealstage, pipeline, closedate, createdate, hs_lastmodifieddate }, createdAt, updatedAt }. `limit` (default 100, max 100) caps page_size of the single first-page request.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const params = new URLSearchParams({
        limit: String(p.limit ?? 100),
        properties: DEAL_PROPERTIES,
      });
      return jsonResult(await hubspotGet(`/crm/v3/objects/deals?${params.toString()}`));
    },
  );

  reg(
    "hubspot_get",
    "Fetch one HubSpot deal by its id (GET /crm/v3/objects/deals/{dealId}?properties=dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate). Returns the deal object directly (NOT wrapped in `results`). Throws when no deal with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const params = new URLSearchParams({ properties: DEAL_PROPERTIES });
      return jsonResult(
        await hubspotGet(`/crm/v3/objects/deals/${encodeURIComponent(p.id)}?${params.toString()}`),
      );
    },
  );

  reg(
    "hubspot_search",
    "**Substring search over the FIRST PAGE only** (up to 100 most-recently-listed deals) of the authenticated portal's HubSpot deals. This tool fetches GET /crm/v3/objects/deals?limit=100 once and matches the query locally (case-insensitive) against the deal name, deal stage, and pipeline. **Deals beyond the first page are not searchable here — query the local Nimbus index instead for full coverage.** Returns a { matches: [...] } envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const params = new URLSearchParams({ limit: "100", properties: DEAL_PROPERTIES });
      const root = await hubspotGet(`/crm/v3/objects/deals?${params.toString()}`);
      const matches = filterHubspotDeals(dealsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
