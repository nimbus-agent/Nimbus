import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
import { filterTableauViews } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["TABLEAU_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("TABLEAU_URL is not set");
  }
  return trimTrailingSlash(v);
}

function patName(): string {
  const v = process.env["TABLEAU_PAT_NAME"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("TABLEAU_PAT_NAME is not set");
  }
  return v;
}

function patSecret(): string {
  const v = process.env["TABLEAU_PAT_SECRET"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("TABLEAU_PAT_SECRET is not set");
  }
  return v;
}

interface SigninResult {
  token: string;
  siteId: string;
}

async function tableauSignin(): Promise<SigninResult> {
  const base = apiBase();
  const res = await fetchWithTimeout(`${base}/api/3.4/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      credentials: {
        personalAccessTokenName: patName(),
        personalAccessTokenSecret: patSecret(),
        site: { contentUrl: "" },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tableau signin ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  const root =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const creds = root?.["credentials"];
  const credsObj =
    creds !== null && typeof creds === "object" && !Array.isArray(creds)
      ? (creds as Record<string, unknown>)
      : null;
  const token = typeof credsObj?.["token"] === "string" ? credsObj["token"] : null;
  const site = credsObj?.["site"];
  const siteObj =
    site !== null && typeof site === "object" && !Array.isArray(site)
      ? (site as Record<string, unknown>)
      : null;
  const siteId = typeof siteObj?.["id"] === "string" ? siteObj["id"] : null;
  if (token === null || siteId === null) {
    throw new Error("Tableau signin response missing credentials.token or credentials.site.id");
  }
  return { token, siteId };
}

/**
 * List views for a site. With a `page`, requests Tableau's 1-based `pageSize`/`pageNumber` paging and
 * returns `pagination.totalAvailable`; without it (used by `_get`/`_search`), returns the default page
 * with `totalAvailable: 0`.
 */
async function listViews(
  token: string,
  siteId: string,
  page?: { pageSize: number; pageNumber: number },
): Promise<{ views: unknown[]; totalAvailable: number }> {
  const base = apiBase();
  const qs = page === undefined ? "" : `?pageSize=${page.pageSize}&pageNumber=${page.pageNumber}`;
  const res = await fetchWithTimeout(
    `${base}/api/3.4/sites/${encodeURIComponent(siteId)}/views${qs}`,
    { headers: { "X-Tableau-Auth": token, Accept: "application/json" } },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tableau views ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  const root =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const views = root?.["views"];
  const viewsObj =
    views !== null && typeof views === "object" && !Array.isArray(views)
      ? (views as Record<string, unknown>)
      : null;
  const pagination = root?.["pagination"];
  const paginationObj =
    pagination !== null && typeof pagination === "object" && !Array.isArray(pagination)
      ? (pagination as Record<string, unknown>)
      : null;
  return {
    views: Array.isArray(viewsObj?.["view"]) ? (viewsObj["view"] as unknown[]) : [],
    totalAvailable: Number(paginationObj?.["totalAvailable"]) || 0,
  };
}

async function tableauRefresh(kind: "datasources" | "workbooks", id: string): Promise<string> {
  const { token, siteId } = await tableauSignin();
  const base = apiBase();
  const res = await fetchWithTimeout(
    `${base}/api/3.4/sites/${encodeURIComponent(siteId)}/${kind}/${encodeURIComponent(id)}/refresh`,
    {
      method: "POST",
      headers: {
        "X-Tableau-Auth": token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Tableau ${kind} refresh ${String(res.status)}: ${text.slice(0, 400)}`);
  const root = JSON.parse(text) as { job?: { id?: string } };
  const jobId = root.job?.id;
  if (jobId === undefined || jobId === "") {
    // Fail closed: a 2xx with no job id is a malformed response; do not report it as a queued
    // refresh (which would make the agent treat a non-started refresh as success).
    throw new Error(`Tableau ${kind} refresh: response missing job.id: ${text.slice(0, 400)}`);
  }
  return jobId;
}

export function registerTableauTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "tableau",
    scopeEnv: "NIMBUS_MCP_TABLEAU_WRITE_SCOPE",
    scopeKinds: ["resource"],
  });

  reg(
    "tableau_list",
    "List Tableau views/dashboards (`GET /api/3.4/sites/{siteId}/views`). Requires a PAT sign-in first. Paginated (1-based): `cursor` (page number) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const pageSize = p.limit ?? 200;
      // 1-based: null / "" / "0" / non-numeric / negative / fractional all resolve to page 1
      // (never page 0 / a negative or out-of-bounds page).
      const parsedPage = Math.trunc(Number(p.cursor));
      const pageNumber = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
      const { token, siteId } = await tableauSignin();
      const { views, totalAvailable } = await listViews(token, siteId, { pageSize, pageNumber });
      const nextCursor = pageNumber * pageSize < totalAvailable ? String(pageNumber + 1) : null;
      return jsonResult({ items: views, nextCursor });
    },
  );

  reg(
    "tableau_get",
    "Fetch one Tableau view by its luid. Throws when no view with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const { token, siteId } = await tableauSignin();
      const { views } = await listViews(token, siteId);
      const found = views.find((v) => {
        const obj =
          v !== null && typeof v === "object" && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : null;
        return obj?.["luid"] === p.id || obj?.["id"] === p.id;
      });
      if (found === undefined) {
        throw new Error(`Tableau view not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "tableau_search",
    "Substring search across Tableau views. Matches the query (case-insensitive) against view name and luid. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const { token, siteId } = await tableauSignin();
      const { views } = await listViews(token, siteId);
      const matches = filterTableauViews(views, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  registerWriteTool(
    "tableau_datasource_refresh",
    {
      mutates: "tableau.datasource.refresh",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "resource", value: p.id }),
    },
    "Trigger an extract refresh for a published datasource. Async — returns the job id.",
    z.object({ id: z.string().min(1) }),
    async (p) => jsonResult({ status: "queued", jobId: await tableauRefresh("datasources", p.id) }),
  );

  registerWriteTool(
    "tableau_workbook_refresh",
    {
      mutates: "tableau.workbook.refresh",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "resource", value: p.id }),
    },
    "Trigger an extract refresh for a workbook. Async — returns the job id.",
    z.object({ id: z.string().min(1) }),
    async (p) => jsonResult({ status: "queued", jobId: await tableauRefresh("workbooks", p.id) }),
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-tableau", registerTableauTools);
}

if (import.meta.main) await startConnector();
