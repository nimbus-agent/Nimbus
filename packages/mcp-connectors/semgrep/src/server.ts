/**
 * nimbus-mcp-semgrep — Semgrep AppSec Platform REST API MCP server
 * (read-only).
 *
 * Exposes the three mandatory read tools (`semgrep_list`, `semgrep_get`,
 * `semgrep_search`) per the Nimbus connector authoring contract. No write
 * tools are registered and `hitlRequired` is empty in the manifest —
 * `semgrep.finding.triage` is a deferred Phase 8 follow-up.
 *
 * Credentials arrive as `SEMGREP_TOKEN` env, injected at spawn time by the
 * Gateway from the `semgrep.token` vault key. `SEMGREP_DEPLOYMENT_SLUG` is
 * required for any deployment-scoped read; the gateway-side syncable
 * discovers the slug from `/deployments` if unset. The connector never
 * reaches for the vault itself (per the project's non-negotiable #3).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterSemgrepFindings } from "./search-filter.ts";

const SEMGREP_API = "https://semgrep.dev/api/v1";
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const STATUSES = ["open", "ignored", "fixed", "removed"] as const;

function deploymentSlug(): string | undefined {
  const v = process.env["SEMGREP_DEPLOYMENT_SLUG"]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function authHeader(): Record<string, string> {
  const t = process.env["SEMGREP_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SEMGREP_TOKEN is not set");
  }
  return { Authorization: `Bearer ${t}`, Accept: "application/json" };
}

async function semgrepGet(path: string): Promise<unknown> {
  const res = await fetch(`${SEMGREP_API}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Semgrep ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function requireSlug(): string {
  const slug = deploymentSlug();
  if (slug === undefined) {
    throw new Error("SEMGREP_DEPLOYMENT_SLUG is not set");
  }
  return slug;
}

const mcp = new McpServer({ name: "nimbus-semgrep", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "semgrep_list",
  "List Semgrep deployments, or open findings for the configured deployment. When called without filters, returns the user's deployments (`/deployments`). Provide a `severity` or `status` filter to query findings under the deployment slug from `SEMGREP_DEPLOYMENT_SLUG` env.",
  z.object({
    severity: z.array(z.enum(SEVERITIES)).min(1).optional(),
    status: z.array(z.enum(STATUSES)).min(1).optional(),
    repository: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async (p) => {
    if (p.severity === undefined && p.status === undefined && p.repository === undefined) {
      return jsonResult(await semgrepGet("/deployments"));
    }
    const slug = requireSlug();
    const search = new URLSearchParams({
      page_size: String(p.limit ?? 100),
    });
    if (p.severity !== undefined && p.severity.length > 0) {
      search.set("severities", p.severity.join(","));
    }
    if (p.status !== undefined && p.status.length > 0) {
      search.set("statuses", p.status.join(","));
    }
    if (p.repository !== undefined) {
      search.set("repos", p.repository);
    }
    const path = `/deployments/${encodeURIComponent(slug)}/findings?${search.toString()}`;
    return jsonResult(await semgrepGet(path));
  },
);

reg(
  "semgrep_get",
  "Fetch one Semgrep finding by id from the configured deployment. Returns the matching finding envelope; throws when no match is found.",
  z.object({
    findingId: z.string().min(1),
  }),
  async (p) => {
    const slug = requireSlug();
    const search = new URLSearchParams({ ids: p.findingId, page_size: "1" });
    const path = `/deployments/${encodeURIComponent(slug)}/findings?${search.toString()}`;
    const root = await semgrepGet(path);
    const findings = (root as { findings?: unknown[] } | null)?.findings;
    if (!Array.isArray(findings) || findings.length === 0) {
      throw new Error(`Semgrep: finding ${p.findingId} not found`);
    }
    return jsonResult(findings[0]);
  },
);

reg(
  "semgrep_search",
  "Substring search across the deployment's open findings. Matches the query against `rule_name`, `rule_message`, `location.file_path`, and `repository.name` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    const slug = requireSlug();
    const search = new URLSearchParams({
      statuses: "open",
      page_size: "500",
    });
    const path = `/deployments/${encodeURIComponent(slug)}/findings?${search.toString()}`;
    const root = await semgrepGet(path);
    const findings = (root as { findings?: unknown[] } | null)?.findings;
    const matches = Array.isArray(findings)
      ? filterSemgrepFindings(findings, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
