import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterDatabricksJobs } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["DATABRICKS_HOST"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("DATABRICKS_HOST is not set");
  }
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const k = process.env["DATABRICKS_TOKEN"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("DATABRICKS_TOKEN is not set");
  }
  return { Authorization: `Bearer ${k}`, Accept: "application/json" };
}

async function dbGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Databricks ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function jobsFrom(root: unknown): unknown[] {
  const jobs = (root as { jobs?: unknown } | null)?.jobs;
  return Array.isArray(jobs) ? jobs : [];
}

await runReadOnlyMcpConnector("nimbus-databricks", (reg) => {
  reg(
    "databricks_list",
    "List Databricks jobs (`GET /api/2.1/jobs/list`). Returns a single page; `limit` (1..100, default 25) caps the page size. Returns the raw `{ jobs, has_more, next_page_token }` envelope.",
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 25;
      const params = new URLSearchParams({ limit: String(limit) });
      return jsonResult(await dbGet(`/api/2.1/jobs/list?${params.toString()}`));
    },
  );

  reg(
    "databricks_get",
    "Fetch one Databricks job by numeric `jobId` (`GET /api/2.1/jobs/get?job_id={jobId}`). Throws when no job with that id exists.",
    z.object({
      jobId: z.number().int(),
    }),
    async (p) => {
      const params = new URLSearchParams({ job_id: String(p.jobId) });
      return jsonResult(await dbGet(`/api/2.1/jobs/get?${params.toString()}`));
    },
  );

  reg(
    "databricks_search",
    "Substring search across Databricks jobs. Matches the query (case-insensitive) against the job's `settings.name`, `creator_user_name`, and `job_id`. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const params = new URLSearchParams({ limit: "100" });
      const root = await dbGet(`/api/2.1/jobs/list?${params.toString()}`);
      const matches = filterDatabricksJobs(jobsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
