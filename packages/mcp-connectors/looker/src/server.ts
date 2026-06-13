import { z } from "zod";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterLookerDashboards } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["LOOKER_BASE_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("LOOKER_BASE_URL is not set");
  }
  return trimTrailingSlash(v);
}

function clientId(): string {
  const v = process.env["LOOKER_CLIENT_ID"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("LOOKER_CLIENT_ID is not set");
  }
  return v;
}

function clientSecret(): string {
  const v = process.env["LOOKER_CLIENT_SECRET"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("LOOKER_CLIENT_SECRET is not set");
  }
  return v;
}

async function lookerLogin(): Promise<string> {
  const base = apiBase();
  const body = `client_id=${encodeURIComponent(clientId())}&client_secret=${encodeURIComponent(clientSecret())}`;
  const res = await fetchWithTimeout(`${base}/api/4.0/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Looker login ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  const root =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const token = typeof root?.["access_token"] === "string" ? root["access_token"] : null;
  if (token === null || token === "") {
    throw new Error("Looker login response missing access_token");
  }
  return token;
}

async function listDashboards(token: string): Promise<unknown[]> {
  const base = apiBase();
  const res = await fetchWithTimeout(`${base}/api/4.0/dashboards`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Looker dashboards ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

await runReadOnlyMcpConnector("nimbus-looker", (reg) => {
  reg(
    "looker_list",
    "List Looker dashboards (`GET /api/4.0/dashboards`). Requires a client-credentials login first. `limit` (default 200, max 500) caps the returned list client-side.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const token = await lookerLogin();
      const dashboards = await listDashboards(token);
      const cap = p.limit ?? 200;
      return jsonResult({ items: dashboards.slice(0, cap) });
    },
  );

  reg(
    "looker_get",
    "Fetch one Looker dashboard by its id. Throws when no dashboard with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const token = await lookerLogin();
      const dashboards = await listDashboards(token);
      const found = dashboards.find((d) => {
        const obj =
          d !== null && typeof d === "object" && !Array.isArray(d)
            ? (d as Record<string, unknown>)
            : null;
        return obj?.["id"] === p.id;
      });
      if (found === undefined) {
        throw new Error(`Looker dashboard not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "looker_search",
    "Substring search across Looker dashboards. Matches the query (case-insensitive) against dashboard title and id. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const token = await lookerLogin();
      const dashboards = await listDashboards(token);
      const matches = filterLookerDashboards(dashboards, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
