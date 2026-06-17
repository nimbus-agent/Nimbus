import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterPipedriveDeals } from "./search-filter.ts";

const BASE = "https://api.pipedrive.com";

function apiToken(): string {
  const t = process.env["PIPEDRIVE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("PIPEDRIVE_TOKEN is not set");
  }
  return t;
}

function withToken(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}${path}${sep}api_token=${encodeURIComponent(apiToken())}`;
}

async function pipedriveGet(path: string, resourceLabel: string): Promise<unknown> {
  const res = await fetch(withToken(path), { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Pipedrive ${resourceLabel} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-pipedrive", (reg) => {
  reg(
    "pipedrive_list",
    "List the user's Pipedrive deals (`GET /v1/deals?limit=100`). Returns the `{ success, data: [...], additional_data: { pagination } }` envelope — `data` holds the deal objects (and may be null when there are no deals).",
    z.object({}),
    async () => {
      return jsonResult(await pipedriveGet(`/v1/deals?limit=100`, "deals"));
    },
  );

  reg(
    "pipedrive_get",
    "Fetch one Pipedrive deal by its id (`GET /v1/deals/{id}`). Returns the `{ success, data: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await pipedriveGet(`/v1/deals/${encodeURIComponent(p.id)}`, "deal"));
    },
  );

  reg(
    "pipedrive_search",
    "Substring search across the user's Pipedrive deals (first page only). Matches the query against the deal title, status, organization name, person name, owner name, and label (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await pipedriveGet(`/v1/deals?limit=100`, "deals");
      const data = (root as { data?: unknown } | null)?.data;
      return matchesResult(data, filterPipedriveDeals, p);
    },
  );
});
