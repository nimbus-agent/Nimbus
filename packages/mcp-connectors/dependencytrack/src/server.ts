import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterDependencyTrackProjects } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["DEPENDENCYTRACK_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("DEPENDENCYTRACK_URL is not set");
  }
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const k = process.env["DEPENDENCYTRACK_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("DEPENDENCYTRACK_API_KEY is not set");
  }
  return { "X-Api-Key": k, Accept: "application/json" };
}

async function dtGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dependency-Track ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function projectsFrom(root: unknown): unknown[] {
  return Array.isArray(root) ? root : [];
}

await runReadOnlyMcpConnector("nimbus-dependencytrack", (reg) => {
  reg(
    "dependencytrack_list",
    "List Dependency-Track projects (GET /api/v1/project?pageSize=100&pageNumber=1&excludeInactive=false). Dependency-Track returns a JSON array of project objects, each embedding its current vulnerability metrics. The optional pageNumber arg (default 1) selects the page; pageSize is fixed at 100.",
    z.object({
      pageNumber: z.number().int().min(1).optional(),
    }),
    async (p) => {
      const page = p.pageNumber ?? 1;
      const root = await dtGet(
        `/api/v1/project?pageSize=100&pageNumber=${encodeURIComponent(String(page))}&excludeInactive=false`,
      );
      return jsonResult({ items: projectsFrom(root) });
    },
  );

  reg(
    "dependencytrack_get",
    "Fetch one Dependency-Track project by its UUID (GET /api/v1/project/{uuid}). Returns the project object directly (NOT wrapped in an array). Throws when no project with that UUID exists.",
    z.object({
      uuid: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await dtGet(`/api/v1/project/${encodeURIComponent(p.uuid)}`));
    },
  );

  reg(
    "dependencytrack_search",
    "Substring search across the first page of Dependency-Track projects. Matches the query (case-insensitive) against the project name, version, classifier, and tag names. Returns a matches envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await dtGet("/api/v1/project?pageSize=100&pageNumber=1&excludeInactive=false");
      const matches = filterDependencyTrackProjects(projectsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
