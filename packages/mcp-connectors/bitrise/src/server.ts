/**
 * nimbus-mcp-bitrise — Bitrise REST API MCP server (read-only).
 *
 * Exposes the three mandatory read tools (`bitrise_list`, `bitrise_get`,
 * `bitrise_search`) per the Nimbus connector authoring contract. No write
 * tools are registered and `hitlRequired` is empty in the manifest.
 *
 * Credentials arrive as `BITRISE_TOKEN` env, injected at spawn time by the
 * Gateway from the `bitrise.token` vault key. The connector never reaches
 * for the vault itself (per the project's non-negotiable #3).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterBitriseBuilds } from "./search-filter.ts";

const BITRISE_API = "https://api.bitrise.io";

function authHeader(): Record<string, string> {
  const t = process.env["BITRISE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("BITRISE_TOKEN is not set");
  }
  // Bitrise v0.1 uses a bare PAT in the Authorization header — no Bearer scheme.
  return { Authorization: t, Accept: "application/json" };
}

async function bitriseGet(path: string): Promise<unknown> {
  const res = await fetch(`${BITRISE_API}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bitrise ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-bitrise", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "bitrise_list",
  "List Bitrise resources. When `appSlug` is omitted, returns the user's accessible apps via `/v0.1/me/apps`. When `appSlug` is provided, returns the app's recent builds via `/v0.1/apps/<slug>/builds` (status filter and limit optional).",
  z.object({
    appSlug: z.string().min(1).optional(),
    status: z.enum(["not-finished", "successful", "failed", "aborted"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async (p) => {
    if (p.appSlug === undefined) {
      const limit = p.limit ?? 50;
      return jsonResult(await bitriseGet(`/v0.1/me/apps?limit=${String(limit)}`));
    }
    const params: string[] = [];
    params.push(`limit=${String(p.limit ?? 50)}`);
    if (p.status !== undefined) {
      // Bitrise build status query mapping:
      //   not-finished → status=0, successful → 1, failed → 2, aborted → 3.
      const map = { "not-finished": 0, successful: 1, failed: 2, aborted: 3 } as const;
      params.push(`status=${String(map[p.status])}`);
    }
    const qs = `?${params.join("&")}`;
    return jsonResult(await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds${qs}`));
  },
);

reg(
  "bitrise_get",
  "Fetch a single Bitrise resource. When `buildSlug` is provided, returns the build via `/v0.1/apps/<appSlug>/builds/<buildSlug>`. When omitted, returns the app via `/v0.1/apps/<appSlug>`.",
  z.object({
    appSlug: z.string().min(1),
    buildSlug: z.string().min(1).optional(),
  }),
  async (p) => {
    if (p.buildSlug === undefined) {
      return jsonResult(await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}`));
    }
    const path = `/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds/${encodeURIComponent(p.buildSlug)}`;
    return jsonResult(await bitriseGet(path));
  },
);

reg(
  "bitrise_search",
  "Substring search across a Bitrise app's recent builds. Matches the query against `branch`, `commit_message`, `triggered_workflow`, and `status_text` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    appSlug: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    // Pull a generous page (cap 50 per Bitrise) and filter client-side.
    const root = await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds?limit=50`);
    const data = (root as { data?: unknown[] } | null)?.data;
    const matches = Array.isArray(data)
      ? filterBitriseBuilds(data, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
