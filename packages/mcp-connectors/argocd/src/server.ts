/**
 * nimbus-mcp-argocd — ArgoCD API MCP server (read-only).
 * Credentials arrive as ARGOCD_URL + ARGOCD_TOKEN env, injected at spawn time.
 * ArgoCD API tokens (from `argocd account generate-token`) are sent as
 * `Authorization: Bearer <token>`. ArgoCD is always self-hosted, so there is
 * no SaaS default for ARGOCD_URL — it must be set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterArgocdApplications } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["ARGOCD_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("ARGOCD_URL is not set");
  }
  return `${trimTrailingSlash(v)}/api/v1`;
}

function authHeader(): Record<string, string> {
  const t = process.env["ARGOCD_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("ARGOCD_TOKEN is not set");
  }
  return { Authorization: `Bearer ${t}`, Accept: "application/json" };
}

async function agGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ArgoCD ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

/** Pull the `items` array out of an `/applications` response (or a bare array). */
function applicationsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const items = (root as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

const mcp = new McpServer({ name: "nimbus-argocd", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "argocd_list",
  "List ArgoCD applications. Optionally filter by `project` (passes `?projects=<project>` to the API). ArgoCD returns the full list in one response; `limit` (default 200) caps the returned `items` client-side.",
  z.object({
    project: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams();
    if (p.project !== undefined && p.project !== "") {
      search.set("projects", p.project);
    }
    const qs = search.toString();
    const root = await agGet(`/applications${qs === "" ? "" : `?${qs}`}`);
    const apps = applicationsFrom(root);
    const cap = p.limit ?? 200;
    return jsonResult({ items: apps.slice(0, cap) });
  },
);

reg(
  "argocd_get",
  "Fetch one ArgoCD application by name (`/applications/{name}`). Throws when no application with that name exists.",
  z.object({
    name: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await agGet(`/applications/${encodeURIComponent(p.name)}`));
  },
);

reg(
  "argocd_search",
  "Substring search across ArgoCD applications. Matches the query (case-insensitive) against application name, project, source repo URL, sync status, and health status. Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    const root = await agGet("/applications");
    const matches = filterArgocdApplications(applicationsFrom(root), {
      query: p.query,
      limit: p.limit,
    });
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
