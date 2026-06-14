import { z } from "zod";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
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
  const res = await fetchWithTimeout(url, {
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

function asRec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function listReports(accessToken: string): Promise<unknown[]> {
  const res = await fetchWithTimeout("https://api.powerbi.com/v1.0/myorg/reports", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Power BI reports error ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const value = asRec(JSON.parse(text) as unknown)?.["value"];
  return Array.isArray(value) ? value : [];
}

/** Fetch a dataset's table names for lineage (`GET /datasets/{id}/tables`); empty on any failure. */
async function fetchDatasetTables(accessToken: string, datasetId: string): Promise<string[]> {
  const res = await fetchWithTimeout(
    `https://api.powerbi.com/v1.0/myorg/datasets/${encodeURIComponent(datasetId)}/tables`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );
  if (!res.ok) return [];
  const value = asRec(JSON.parse(await res.text()) as unknown)?.["value"];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const name = asRec(item)?.["name"];
    if (typeof name === "string" && name !== "") out.push(name);
  }
  return out;
}

/** Attach each report's dataset-table refs in-session, so the gateway never makes a second credentialed call. */
async function expandReport(accessToken: string, report: unknown): Promise<unknown> {
  const r = asRec(report);
  if (r === undefined) return report;
  const datasetId = r["datasetId"];
  const datasetTables =
    typeof datasetId === "string" && datasetId !== ""
      ? await fetchDatasetTables(accessToken, datasetId)
      : [];
  return { ...r, datasetTables };
}

export function registerPowerBiTools(reg: ZodToolRegistrar): void {
  reg(
    "powerbi_list",
    "List Power BI reports (`GET /v1.0/myorg/reports`), each expanded with its dataset-table refs for lineage. The reports endpoint returns the full org list in one response and has no reliable server paging, so this is a single fetch returning ALL reports with `nextCursor: null` (`cursor`/`limit` are accepted for `_list` API symmetry but never truncate).",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      const tenantId = requireEnv("POWERBI_TENANT_ID");
      const clientId = requireEnv("POWERBI_CLIENT_ID");
      const clientSecret = requireEnv("POWERBI_CLIENT_SECRET");
      const accessToken = await fetchAccessToken(tenantId, clientId, clientSecret);
      // Return EVERY report: slicing to `limit` would silently drop reports (nextCursor is null, so
      // the gateway drain stops) and lose them from the index for orgs with many reports.
      const reports = await listReports(accessToken);
      const items = await Promise.all(reports.map((r) => expandReport(accessToken, r)));
      return jsonResult({ items, nextCursor: null });
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
}

// Only connect a real stdio transport when run as the connector entrypoint (not when imported by tests).
if (import.meta.main) {
  await runReadOnlyMcpConnector("nimbus-powerbi", registerPowerBiTools);
}
