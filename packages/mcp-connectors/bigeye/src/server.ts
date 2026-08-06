import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
import { filterBigeyeIssues } from "./search-filter.ts";

function apiBase(): string {
  const v = process.env["BIGEYE_BASE_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("BIGEYE_BASE_URL is not set");
  }
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

function authHeader(): Record<string, string> {
  const k = process.env["BIGEYE_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("BIGEYE_API_KEY is not set");
  }
  return { Authorization: `Bearer ${k}`, Accept: "application/json" };
}

/** One page of issues (`GET /api/v1/issues?limit&offset`), tolerant of array / `{issues}` / `{data}`. */
async function fetchIssues(limit: number, offset: number): Promise<unknown[]> {
  const url = `${apiBase()}/api/v1/issues?limit=${String(limit)}&offset=${String(offset)}`;
  const res = await fetchWithTimeout(url, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bigeye ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed !== null && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root["issues"])) return root["issues"];
    if (Array.isArray(root["data"])) return root["data"];
  }
  return [];
}

function issueId(item: unknown): string {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return "";
  const row = item as Record<string, unknown>;
  const v = row["id"];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/** Update a Bigeye issue status via `POST /api/v1/issues`. */
async function updateIssueStatus(issueId: string, status: string): Promise<void> {
  const base = apiBase();
  const res = await fetchWithTimeout(`${base}/api/v1/issues`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ issueId, status }),
  });
  if (!res.ok) {
    throw new Error(
      `Bigeye updateIssue ${String(res.status)}: ${(await res.text()).slice(0, 400)}`,
    );
  }
}

export function registerBigeyeTools(reg: ZodToolRegistrar): void {
  reg(
    "bigeye_list",
    "List Bigeye data-quality issues (`GET /api/v1/issues`). Paginated: `cursor` (offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 200;
      // null / undefined / "" / non-numeric / negative all clamp to offset 0; fractional truncates.
      const offset = Math.max(0, Math.trunc(Number(p.cursor) || 0));
      const issues = await fetchIssues(limit, offset);
      const nextCursor = issues.length === limit ? String(offset + limit) : null;
      return jsonResult({ items: issues, nextCursor });
    },
  );

  reg(
    "bigeye_get",
    "Fetch one Bigeye data-quality issue by its id. Throws when the issue is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const issues = await fetchIssues(500, 0);
      const found = issues.find((item) => issueId(item) === p.id);
      if (found === undefined) {
        throw new Error(`Bigeye issue not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "bigeye_search",
    "Substring search across Bigeye data-quality issues. Matches the query (case-insensitive) against issue summary, title, and description. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const issues = await fetchIssues(500, 0);
      const matches = filterBigeyeIssues(issues, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  reg(
    "bigeye_issue_acknowledge",
    "Acknowledge a Bigeye issue (requires HITL bigeye.issue.acknowledge).",
    z.object({ issueId: z.string().min(1) }),
    async (p) => {
      await updateIssueStatus(p.issueId, "ISSUE_STATUS_ACKNOWLEDGED");
      return jsonResult({ status: "ok", issueId: p.issueId });
    },
  );

  reg(
    "bigeye_issue_resolve",
    "Resolve (close) a Bigeye issue (requires HITL bigeye.issue.resolve).",
    z.object({ issueId: z.string().min(1) }),
    async (p) => {
      await updateIssueStatus(p.issueId, "ISSUE_STATUS_CLOSED");
      return jsonResult({ status: "ok", issueId: p.issueId });
    },
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-bigeye", registerBigeyeTools);
}

if (import.meta.main) await startConnector();
