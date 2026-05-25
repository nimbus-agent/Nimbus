/**
 * nimbus-mcp-metabase — Metabase API MCP server (read-only).
 * Credentials arrive as METABASE_URL + METABASE_API_KEY env, injected at
 * spawn time. The Metabase API key is sent as the `x-api-key` request header
 * (NOT `Authorization`). Metabase has no universal SaaS host, so there is no
 * default for METABASE_URL — it must be set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterMetabaseDashboards } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["METABASE_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("METABASE_URL is not set");
  }
  // Metabase paths already include `/api/...`, so the base is just the host root.
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const k = process.env["METABASE_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("METABASE_API_KEY is not set");
  }
  return { "x-api-key": k, Accept: "application/json" };
}

async function mbGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Metabase ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

/** Pull the dashboard array out of a `/api/dashboard` response (bare array, else `.data`). */
function dashboardsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const data = (root as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

const mcp = new McpServer({ name: "nimbus-metabase", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "metabase_list",
  "List Metabase dashboards (`GET /api/dashboard`). Metabase returns the full list in one response; `limit` (default 200) caps the returned list client-side.",
  z.object({
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async (p) => {
    const root = await mbGet("/api/dashboard");
    const dashboards = dashboardsFrom(root);
    const cap = p.limit ?? 200;
    return jsonResult({ items: dashboards.slice(0, cap) });
  },
);

reg(
  "metabase_get",
  "Fetch one Metabase dashboard by numeric id (`/api/dashboard/{id}`). Throws when no dashboard with that id exists.",
  z.object({
    id: z.number().int(),
  }),
  async (p) => {
    return jsonResult(await mbGet(`/api/dashboard/${encodeURIComponent(String(p.id))}`));
  },
);

reg(
  "metabase_search",
  "Substring search across Metabase dashboards. Matches the query (case-insensitive) against dashboard name and description. Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    const root = await mbGet("/api/dashboard");
    const matches = filterMetabaseDashboards(dashboardsFrom(root), {
      query: p.query,
      limit: p.limit,
    });
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
