/**
 * nimbus-mcp-pipedrive — Pipedrive REST API MCP server (read-only).
 * Credentials arrive as PIPEDRIVE_TOKEN env, injected at spawn time.
 *
 * AUTH: Pipedrive authenticates with the token IN THE QUERY STRING
 * (`?api_token=<token>`) — there is NO Authorization header, so every request
 * URL contains the secret. CONSEQUENCE: the request URL (and anything derived
 * from it) MUST NEVER appear in a thrown Error message or any log line. Errors
 * are built from the HTTP status code + the resource label + a token-free
 * response-body slice only (Pipedrive error bodies do not echo the token; the
 * slice is still capped). The API host is fixed at api.pipedrive.com (no host
 * override). v1 indexes deals only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterPipedriveDeals } from "./search-filter.ts";

const BASE = "https://api.pipedrive.com";

function apiToken(): string {
  const t = process.env["PIPEDRIVE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("PIPEDRIVE_TOKEN is not set");
  }
  return t;
}

/**
 * Append `api_token=<token>` to a path's query string. The token goes in the
 * URL because Pipedrive has no Authorization header. The caller must NEVER pass
 * the returned URL into a log line or error message.
 */
function withToken(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}${path}${sep}api_token=${encodeURIComponent(apiToken())}`;
}

/**
 * GET a Pipedrive resource. On a non-2xx, throw using only the status code, the
 * caller-supplied resource LABEL (never the URL — it carries the token), and a
 * token-free body slice.
 */
async function pipedriveGet(path: string, resourceLabel: string): Promise<unknown> {
  const res = await fetch(withToken(path), { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Pipedrive ${resourceLabel} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-pipedrive", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

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
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await pipedriveGet(`/v1/deals?limit=100`, "deals");
    const data = (root as { data?: unknown } | null)?.data;
    const matches = Array.isArray(data)
      ? filterPipedriveDeals(data, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
