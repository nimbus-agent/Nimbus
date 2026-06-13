import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
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
  const res = await fetch(`${base}/api/3.4/auth/signin`, {
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

async function listViews(token: string, siteId: string): Promise<unknown[]> {
  const base = apiBase();
  const res = await fetch(`${base}/api/3.4/sites/${encodeURIComponent(siteId)}/views`, {
    headers: { "X-Tableau-Auth": token, Accept: "application/json" },
  });
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
  return Array.isArray(viewsObj?.["view"]) ? (viewsObj["view"] as unknown[]) : [];
}

await runReadOnlyMcpConnector("nimbus-tableau", (reg) => {
  reg(
    "tableau_list",
    "List Tableau views/dashboards (`GET /api/3.4/sites/{siteId}/views`). Requires a PAT sign-in first. `limit` (default 200, max 500) caps the returned list client-side.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const { token, siteId } = await tableauSignin();
      const views = await listViews(token, siteId);
      const cap = p.limit ?? 200;
      return jsonResult({ items: views.slice(0, cap) });
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
      const views = await listViews(token, siteId);
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
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const { token, siteId } = await tableauSignin();
      const views = await listViews(token, siteId);
      const matches = filterTableauViews(views, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
