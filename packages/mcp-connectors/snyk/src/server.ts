/**
 * nimbus-mcp-snyk — Snyk REST API MCP server (read-only).
 *
 * Exposes the three mandatory read tools (`snyk_list`, `snyk_get`,
 * `snyk_search`) per the Nimbus connector authoring contract. No write
 * tools are registered and `hitlRequired` is empty in the manifest —
 * `snyk.issue.ignore` is a deferred Phase 8 follow-up.
 *
 * Credentials arrive as `SNYK_TOKEN` env, injected at spawn time by the
 * Gateway from the `snyk.token` vault key. The connector never reaches
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
import { filterSnykAggregatedIssues } from "./search-filter.ts";

const SNYK_API = "https://api.snyk.io";

function authHeader(): Record<string, string> {
  const t = process.env["SNYK_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SNYK_TOKEN is not set");
  }
  // Snyk REST uses the `token <value>` Authorization scheme rather than Bearer.
  return { Authorization: `token ${t}`, Accept: "application/json" };
}

async function snykGet(path: string): Promise<unknown> {
  const res = await fetch(`${SNYK_API}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Snyk ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

async function snykPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SNYK_API}${path}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Snyk ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  // Some Snyk POST endpoints return an empty body on success; tolerate that.
  if (text.trim() === "") {
    return {};
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-snyk", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "snyk_list",
  "List Snyk projects for an org, or aggregated issues for a project. When projectId is omitted, returns the org's project list. Severities default to all four (critical/high/medium/low).",
  z.object({
    orgId: z.string().min(1),
    projectId: z.string().min(1).optional(),
    severities: z
      .array(z.enum(["critical", "high", "medium", "low"]))
      .min(1)
      .optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  async (p) => {
    if (p.projectId === undefined) {
      return jsonResult(await snykGet(`/v1/org/${encodeURIComponent(p.orgId)}/projects`));
    }
    const severities = p.severities ?? ["critical", "high", "medium", "low"];
    const body = {
      filters: {
        severities,
        types: ["vuln", "license"],
        ignored: false,
        patched: false,
      },
    };
    const path = `/v1/org/${encodeURIComponent(p.orgId)}/project/${encodeURIComponent(p.projectId)}/aggregated-issues`;
    const data = await snykPost(path, body);
    if (p.limit !== undefined && data !== null && typeof data === "object") {
      const issues = (data as { issues?: unknown[] }).issues;
      if (Array.isArray(issues) && issues.length > p.limit) {
        return jsonResult({
          ...(data as Record<string, unknown>),
          issues: issues.slice(0, p.limit),
        });
      }
    }
    return jsonResult(data);
  },
);

reg(
  "snyk_get",
  "Fetch one Snyk issue by id from an org + project. Returns the aggregated-issue envelope for the matching `issue.id`; throws when no match is found.",
  z.object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    issueId: z.string().min(1),
  }),
  async (p) => {
    const body = {
      filters: {
        severities: ["critical", "high", "medium", "low"],
        types: ["vuln", "license"],
        ignored: false,
        patched: false,
      },
    };
    const path = `/v1/org/${encodeURIComponent(p.orgId)}/project/${encodeURIComponent(p.projectId)}/aggregated-issues`;
    const root = await snykPost(path, body);
    const issues = (root as { issues?: unknown[] } | null)?.issues;
    if (!Array.isArray(issues)) {
      throw new Error(`Snyk: project ${p.projectId} returned no issues envelope`);
    }
    const match = issues.find((it) => {
      if (it === null || typeof it !== "object") {
        return false;
      }
      const id = (it as { id?: unknown }).id;
      return typeof id === "string" && id === p.issueId;
    });
    if (match === undefined) {
      throw new Error(`Snyk: issue ${p.issueId} not found in project ${p.projectId}`);
    }
    return jsonResult(match);
  },
);

reg(
  "snyk_search",
  "Substring search across a project's aggregated issues. Matches the query against `issueData.title`, `issueData.cve`, and `pkgName` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    const body = {
      filters: {
        severities: ["critical", "high", "medium", "low"],
        types: ["vuln", "license"],
        ignored: false,
        patched: false,
      },
    };
    const path = `/v1/org/${encodeURIComponent(p.orgId)}/project/${encodeURIComponent(p.projectId)}/aggregated-issues`;
    const root = await snykPost(path, body);
    const issues = (root as { issues?: unknown[] } | null)?.issues;
    const matches = Array.isArray(issues)
      ? filterSnykAggregatedIssues(issues, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
