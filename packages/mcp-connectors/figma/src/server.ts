import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterFigmaFiles } from "./search-filter.ts";

const BASE = "https://api.figma.com";

function apiToken(): string {
  const t = process.env["FIGMA_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("FIGMA_TOKEN is not set");
  }
  return t;
}

function teamId(): string {
  const t = process.env["FIGMA_TEAM_ID"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("FIGMA_TEAM_ID is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function figmaGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Figma ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function projectsFrom(root: unknown): Array<{ id: string; name: string }> {
  const projects = (root as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) {
    return [];
  }
  const out: Array<{ id: string; name: string }> = [];
  for (const p of projects) {
    const rec = p as { id?: unknown; name?: unknown } | null;
    const id = rec?.id;
    if (typeof id === "string" || typeof id === "number") {
      out.push({
        id: String(id),
        name: typeof rec?.name === "string" ? rec.name : "",
      });
    }
  }
  return out;
}

function filesFrom(root: unknown): unknown[] {
  const files = (root as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? files : [];
}

/**
 * Flatten the configured team's projects into a single list of files, tagging
 * each file with its `project_name` for searchability. This is the two-level
 * fetch: GET /v1/teams/<team_id>/projects, then GET /v1/projects/<id>/files for
 * each project.
 */
async function listTeamFiles(): Promise<unknown[]> {
  const projectsRoot = await figmaGet(`/v1/teams/${encodeURIComponent(teamId())}/projects`);
  const projects = projectsFrom(projectsRoot);
  const out: unknown[] = [];
  for (const project of projects) {
    const filesRoot = await figmaGet(`/v1/projects/${encodeURIComponent(project.id)}/files`);
    for (const f of filesFrom(filesRoot)) {
      const rec = f as Record<string, unknown> | null;
      out.push({
        ...rec,
        project_id: project.id,
        project_name: project.name,
      });
    }
  }
  return out;
}

await runReadOnlyMcpConnector("nimbus-figma", (reg) => {
  reg(
    "figma_list",
    "List the configured team's Figma files. Two-level fetch: GET /v1/teams/<team_id>/projects (the team id is injected at spawn from the figma.team_id vault key) returns { name, projects: [{ id, name }] }; then for each project GET /v1/projects/<project_id>/files returns { name, files: [{ key, name, thumbnail_url, last_modified }] }. Returns a flattened { files: [...] } envelope where each file is shaped { key, name, thumbnail_url, last_modified, project_id, project_name }. Neither endpoint paginates — each returns the full list.",
    z.object({}),
    async () => {
      return jsonResult({ files: await listTeamFiles() });
    },
  );

  reg(
    "figma_get",
    "List the files in one Figma project by its id (GET /v1/projects/{projectId}/files). Returns the { name, files: [{ key, name, thumbnail_url, last_modified }] } envelope directly. Throws when no project with that id is accessible.",
    z.object({
      projectId: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await figmaGet(`/v1/projects/${encodeURIComponent(p.projectId)}/files`));
    },
  );

  reg(
    "figma_search",
    "Substring search across the configured team's Figma files. Runs the same two-level fetch as figma_list (team projects, then files per project), flattens the result, and matches the query locally (case-insensitive) against each file name and its project name. Returns a { matches: [...] } envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const files = await listTeamFiles();
      const matches = filterFigmaFiles(files, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
