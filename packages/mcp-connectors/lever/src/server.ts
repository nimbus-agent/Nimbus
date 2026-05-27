/**
 * nimbus-mcp-lever — Lever Data API MCP server (read-only).
 * Credentials arrive as LEVER_API_KEY env, injected at spawn time. Lever uses
 * HTTP Basic auth where the API key is the USERNAME and the password is EMPTY:
 * `Authorization: Basic base64(<api_key>:)` (note the trailing colon — the empty
 * password; never logged). The API host is fixed at api.lever.co (no host
 * override). v1 indexes job postings only — opportunities / candidates are
 * deferred (candidate PII; out of scope for v1).
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
import { filterLeverPostings } from "./search-filter.ts";

const BASE = "https://api.lever.co";

function apiKey(): string {
  const t = process.env["LEVER_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("LEVER_API_KEY is not set");
  }
  return t;
}

/**
 * Build the Basic auth header. Lever's scheme makes the API key the username
 * and the password EMPTY — reuse the shared email:token base64 helper with the
 * API key as the "email" half and an empty-string "token" half, producing
 * `Basic base64(<api_key>:)`. The resulting header is never logged.
 */
function authHeader(): Record<string, string> {
  return { Authorization: encodeBasicAuthHeader(apiKey(), ""), Accept: "application/json" };
}

async function leverGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lever ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-lever", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "lever_list",
  "List the company's published Lever job postings (`GET /v1/postings?limit=100`). Returns the offset-cursor envelope `{ data: [...], hasNext: boolean, next?: string }` — `data` holds the posting objects.",
  z.object({}),
  async () => {
    return jsonResult(await leverGet(`/v1/postings?limit=100`));
  },
);

reg(
  "lever_get",
  "Fetch one Lever job posting by its id (`GET /v1/postings/{id}`). Returns the `{ data: {...} }` envelope. Throws when no match is found.",
  z.object({
    id: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await leverGet(`/v1/postings/${encodeURIComponent(p.id)}`));
  },
);

reg(
  "lever_search",
  "Substring search across the company's Lever job postings (first page only). Matches the query against the posting text (title), state, and the team/department/location categories and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await leverGet(`/v1/postings?limit=100`);
    const data = (root as { data?: unknown[] } | null)?.data;
    const matches = Array.isArray(data)
      ? filterLeverPostings(data, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
