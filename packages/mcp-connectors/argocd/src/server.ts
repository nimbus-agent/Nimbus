import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
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
  const res = await fetchWithTimeout(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ArgoCD ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

async function agPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetchWithTimeout(`${apiBase()}${path}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ArgoCD ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return text === "" ? {} : (JSON.parse(text) as unknown);
}

function applicationsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const items = (root as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

export function registerArgocdTools(reg: ZodToolRegistrar): void {
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
      const queryPart = qs === "" ? "" : `?${qs}`;
      const root = await agGet(`/applications${queryPart}`);
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
    searchToolInputSchema(200),
    async (p) => {
      const root = await agGet("/applications");
      const matches = filterArgocdApplications(applicationsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );

  reg(
    "argocd_app_sync",
    "Trigger a sync for an ArgoCD application (`POST /api/v1/applications/{name}/sync`, requires HITL argocd.app.sync). Async — the sync is requested; verify via the next metadata sync (sync_status/health_status). Recommend /schedule to re-check.",
    z.object({
      name: z.string().min(1),
      prune: z.boolean().optional(),
      revision: z.string().optional(),
    }),
    async (p) => {
      await agPost(`/applications/${encodeURIComponent(p.name)}/sync`, {
        ...(p.prune === undefined ? {} : { prune: p.prune }),
        ...(p.revision === undefined ? {} : { revision: p.revision }),
      });
      return jsonResult({ status: "requested", name: p.name });
    },
  );

  reg(
    "argocd_app_rollback",
    "Roll back an ArgoCD application to a prior deployment history id (`POST /api/v1/applications/{name}/rollback`, requires HITL argocd.app.rollback). Async — verify via the next metadata sync.",
    z.object({ name: z.string().min(1), id: z.number().int().nonnegative() }),
    async (p) => {
      await agPost(`/applications/${encodeURIComponent(p.name)}/rollback`, { id: p.id });
      return jsonResult({ status: "requested", name: p.name });
    },
  );
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-argocd", registerArgocdTools);
}

if (import.meta.main) await startConnector();
