import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterPowerBiReports } from "./search-filter.ts";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set`);
  }
  return v;
}

async function fetchAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body =
    `grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&client_secret=${encodeURIComponent(clientSecret)}` +
    `&scope=${encodeURIComponent("https://analysis.windows.net/powerbi/api/.default")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Power BI token error ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Power BI token response: unexpected shape");
  }
  const token = (parsed as Record<string, unknown>)["access_token"];
  if (typeof token !== "string" || token === "") {
    throw new Error("Power BI token response: missing access_token");
  }
  return token;
}

async function listReports(accessToken: string): Promise<unknown[]> {
  const res = await fetch("https://api.powerbi.com/v1.0/myorg/reports", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Power BI reports error ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const value = (parsed as Record<string, unknown>)["value"];
  return Array.isArray(value) ? value : [];
}

await runReadOnlyMcpConnector("nimbus-powerbi", (reg) => {
  reg(
    "powerbi_list",
    "List Power BI reports (`GET /v1.0/myorg/reports`). `limit` (default 200, max 500) caps the returned list client-side.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const tenantId = requireEnv("POWERBI_TENANT_ID");
      const clientId = requireEnv("POWERBI_CLIENT_ID");
      const clientSecret = requireEnv("POWERBI_CLIENT_SECRET");
      const accessToken = await fetchAccessToken(tenantId, clientId, clientSecret);
      const reports = await listReports(accessToken);
      const cap = p.limit ?? 200;
      return jsonResult({ items: reports.slice(0, cap) });
    },
  );

  reg(
    "powerbi_get",
    "Fetch one Power BI report by its id. Throws when the report is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const tenantId = requireEnv("POWERBI_TENANT_ID");
      const clientId = requireEnv("POWERBI_CLIENT_ID");
      const clientSecret = requireEnv("POWERBI_CLIENT_SECRET");
      const accessToken = await fetchAccessToken(tenantId, clientId, clientSecret);
      const reports = await listReports(accessToken);
      const found = reports.find((r) => {
        if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
        return (r as Record<string, unknown>)["id"] === p.id;
      });
      if (found === undefined) {
        throw new Error(`Power BI report not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "powerbi_search",
    "Substring search across Power BI reports. Matches the query (case-insensitive) against report name and description. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const tenantId = requireEnv("POWERBI_TENANT_ID");
      const clientId = requireEnv("POWERBI_CLIENT_ID");
      const clientSecret = requireEnv("POWERBI_CLIENT_SECRET");
      const accessToken = await fetchAccessToken(tenantId, clientId, clientSecret);
      const reports = await listReports(accessToken);
      const matches = filterPowerBiReports(reports, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
