/**
 * nimbus-mcp-launchdarkly — LaunchDarkly v2 REST API MCP server (read-only).
 * Credentials arrive as LAUNCHDARKLY_TOKEN env, injected at spawn time.
 * LaunchDarkly sends the raw token in the Authorization header — no Bearer prefix.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterLaunchDarklyFlags } from "./search-filter.ts";

const DEFAULT_BASE = "https://app.launchdarkly.com";

function baseUrl(): string {
  const v = process.env["LAUNCHDARKLY_BASE_URL"]?.trim();
  return v === undefined || v === "" ? DEFAULT_BASE : v;
}

function authHeader(): Record<string, string> {
  const t = process.env["LAUNCHDARKLY_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("LAUNCHDARKLY_TOKEN is not set");
  }
  return { Authorization: t, Accept: "application/json" };
}

async function ldGet(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}/api/v2${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LaunchDarkly ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-launchdarkly", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "launchdarkly_list",
  "List LaunchDarkly projects, or feature flags for a project. Without `projectKey`, returns the account's projects (`/projects`). With `projectKey`, returns that project's flags (`/flags/{projectKey}`), capped at `limit` (default 100).",
  z.object({
    projectKey: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async (p) => {
    if (p.projectKey === undefined) {
      return jsonResult(await ldGet("/projects"));
    }
    const search = new URLSearchParams({ summary: "true", limit: String(p.limit ?? 100) });
    return jsonResult(
      await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`),
    );
  },
);

reg(
  "launchdarkly_get",
  "Fetch one LaunchDarkly feature flag by project key + flag key. Throws when no match is found.",
  z.object({
    projectKey: z.string().min(1),
    flagKey: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(
      await ldGet(`/flags/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.flagKey)}`),
    );
  },
);

reg(
  "launchdarkly_search",
  "Substring search across a project's feature flags. Matches the query against flag key, name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    projectKey: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ summary: "true", limit: "500" });
    const root = await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`);
    const flags = (root as { items?: unknown[] } | null)?.items;
    const matches = Array.isArray(flags)
      ? filterLaunchDarklyFlags(flags, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
