import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterNetlifySites } from "./search-filter.ts";

const BASE = "https://api.netlify.com";

function token(): string {
  const t = process.env["NETLIFY_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("NETLIFY_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, Accept: "application/json" };
}

async function netlifyGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Netlify ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-netlify", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "netlify_list",
  "List Netlify sites (`GET /api/v1/sites`), capped at `per_page` (default 100). Returns a bare JSON array of site objects, each carrying the embedded `published_deploy` status and `build_settings`.",
  z.object({
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ per_page: String(p.per_page ?? 100), page: "1" });
    return jsonResult(await netlifyGet(`/api/v1/sites?${search.toString()}`));
  },
);

reg(
  "netlify_get",
  "Fetch one Netlify site by its id (`GET /api/v1/sites/{siteId}`). Returns the site object directly. Throws when no match is found.",
  z.object({
    siteId: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await netlifyGet(`/api/v1/sites/${encodeURIComponent(p.siteId)}`));
  },
);

reg(
  "netlify_search",
  "Substring search across Netlify sites. Matches the query against id, name, url, ssl_url, the linked git repo + branch, and the published-deploy state / branch / commit ref (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ per_page: "100", page: "1" });
    const root = await netlifyGet(`/api/v1/sites?${search.toString()}`);
    const matches = Array.isArray(root)
      ? filterNetlifySites(root, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
