import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterFlagsmithFeatures } from "./search-filter.ts";

const DEFAULT_API_BASE = "https://api.flagsmith.com";

function apiBase(): string {
  const v = process.env["FLAGSMITH_API_BASE"]?.trim();
  return v === undefined || v === "" ? DEFAULT_API_BASE : v;
}

function authHeader(): Record<string, string> {
  const t = process.env["FLAGSMITH_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("FLAGSMITH_TOKEN is not set");
  }
  return { Authorization: `Token ${t}`, Accept: "application/json" };
}

async function fsGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}/api/v1${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Flagsmith ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function featuresFromPage(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const results = (root as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

await runReadOnlyMcpConnector("nimbus-flagsmith", (reg) => {
  reg(
    "flagsmith_list",
    "List Flagsmith projects, or feature flags for a project. Without `projectId`, returns the account's projects (`/projects/`). With `projectId`, returns that project's feature flags (`/projects/{projectId}/features/`), capped at `limit` (default 100).",
    z.object({
      projectId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      if (p.projectId === undefined) {
        return jsonResult(await fsGet("/projects/"));
      }
      const search = new URLSearchParams({ page_size: String(p.limit ?? 100) });
      return jsonResult(
        await fsGet(
          `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
        ),
      );
    },
  );

  reg(
    "flagsmith_get",
    "Fetch one Flagsmith feature flag by project id + feature name. Flagsmith has no GET-by-name endpoint, so this searches the project's features and narrows to the exact-name match. Throws when no match is found.",
    z.object({
      projectId: z.number().int(),
      featureName: z.string().min(1),
    }),
    async (p) => {
      const search = new URLSearchParams({ page_size: "100", search: p.featureName });
      const root = await fsGet(
        `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
      );
      const match = featuresFromPage(root).find(
        (f) =>
          f !== null && typeof f === "object" && (f as { name?: unknown }).name === p.featureName,
      );
      if (match === undefined) {
        throw new Error(`Flagsmith feature not found: ${p.featureName}`);
      }
      return jsonResult(match);
    },
  );

  reg(
    "flagsmith_search",
    "Substring search across a project's feature flags. Matches the query against flag name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      projectId: z.number().int(),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ page_size: "500" });
      const root = await fsGet(
        `/projects/${encodeURIComponent(String(p.projectId))}/features/?${search.toString()}`,
      );
      const matches = filterFlagsmithFeatures(featuresFromPage(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
