/**
 * nimbus-mcp-greenhouse — Greenhouse Harvest API MCP server (read-only).
 * Credentials arrive as GREENHOUSE_API_KEY env, injected at spawn time.
 * Greenhouse uses HTTP Basic auth where the API key is the USERNAME and the
 * password is EMPTY: `Authorization: Basic base64(<api_key>:)` (note the
 * trailing colon — the empty password; never logged). The API host is fixed at
 * harvest.greenhouse.io (no host override). v1 indexes job openings only —
 * candidates / applications are deferred (candidate PII; out of scope for v1).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  encodeBasicAuthHeader,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterGreenhouseJobs } from "./search-filter.ts";

const BASE = "https://harvest.greenhouse.io";

function apiKey(): string {
  const t = process.env["GREENHOUSE_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("GREENHOUSE_API_KEY is not set");
  }
  return t;
}

/**
 * Build the Basic auth header. Greenhouse's scheme makes the API key the
 * username and the password EMPTY — reuse the shared email:token base64 helper
 * with the API key as the "email" half and an empty-string "token" half,
 * producing `Basic base64(<api_key>:)`. The resulting header is never logged.
 */
function authHeader(): Record<string, string> {
  return { Authorization: encodeBasicAuthHeader(apiKey(), ""), Accept: "application/json" };
}

async function greenhouseGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Greenhouse ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-greenhouse", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "greenhouse_list",
  "List the company's Greenhouse Harvest job openings (`GET /v1/jobs?per_page=100`). Returns a bare JSON array of job objects (NOT an envelope), each carrying the name, status, requisition id, departments, and offices.",
  z.object({
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ per_page: String(p.per_page ?? 100), page: "1" });
    return jsonResult(await greenhouseGet(`/v1/jobs?${search.toString()}`));
  },
);

reg(
  "greenhouse_get",
  "Fetch one Greenhouse job by its id (`GET /v1/jobs/{id}`). Returns the job object directly. Throws when no match is found.",
  z.object({
    id: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await greenhouseGet(`/v1/jobs/${encodeURIComponent(p.id)}`));
  },
);

reg(
  "greenhouse_search",
  "Substring search across the company's Greenhouse job openings (first page only). Matches the query against the job name, status, requisition id, the department names, and the office names + locations (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ per_page: "100", page: "1" });
    const root = await greenhouseGet(`/v1/jobs?${search.toString()}`);
    const matches = Array.isArray(root)
      ? filterGreenhouseJobs(root, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
