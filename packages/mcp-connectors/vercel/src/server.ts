import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterVercelDeployments } from "./search-filter.ts";

const BASE = "https://api.vercel.com";

function token(): string {
  const t = process.env["VERCEL_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("VERCEL_TOKEN is not set");
  }
  return t;
}

function teamId(): string | undefined {
  const v = process.env["VERCEL_TEAM_ID"]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, Accept: "application/json" };
}

function withTeam(path: string): string {
  const team = teamId();
  if (team === undefined) {
    return path;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}teamId=${encodeURIComponent(team)}`;
}

async function vercelGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${withTeam(path)}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Vercel ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-vercel", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "vercel_list",
  "List recent Vercel deployments (`GET /v6/deployments`), most-recent-first, capped at `limit` (default 100). Returns the `{ deployments, pagination }` envelope.",
  z.object({
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ limit: String(p.limit ?? 100) });
    return jsonResult(await vercelGet(`/v6/deployments?${search.toString()}`));
  },
);

reg(
  "vercel_get",
  "Fetch one Vercel deployment by its id or *.vercel.app URL (`GET /v13/deployments/{idOrUrl}`). Returns the deployment object directly. Throws when no match is found.",
  z.object({
    idOrUrl: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await vercelGet(`/v13/deployments/${encodeURIComponent(p.idOrUrl)}`));
  },
);

reg(
  "vercel_search",
  "Substring search across recent Vercel deployments. Matches the query against uid, project name, state, target, the *.vercel.app host, and the git commit message (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ limit: "100" });
    const root = await vercelGet(`/v6/deployments?${search.toString()}`);
    const deployments = (root as { deployments?: unknown[] } | null)?.deployments;
    const matches = Array.isArray(deployments)
      ? filterVercelDeployments(deployments, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
