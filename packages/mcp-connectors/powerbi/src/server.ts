import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
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

const POWERBI_API_BASE = "https://api.powerbi.com";

/** Mint an AAD access token from the connector's client-credentials env. */
async function accessToken(): Promise<string> {
  return fetchAccessToken(
    requireEnv("POWERBI_TENANT_ID"),
    requireEnv("POWERBI_CLIENT_ID"),
    requireEnv("POWERBI_CLIENT_SECRET"),
  );
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

export function registerPowerBiTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "powerbi",
    scopeEnv: "NIMBUS_MCP_POWERBI_WRITE_SCOPE",
    scopeKinds: ["workspace"],
  });

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
    searchToolInputSchema(200),
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

  registerWriteTool(
    "powerbi_dataset_refresh",
    {
      mutates: "powerbi.dataset.refresh",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "workspace", value: p.groupId ?? "my-workspace" }),
    },
    "Trigger a dataset refresh. groupId optional (omit for My Workspace). Async (202).",
    // groupId is nullish: indexed dashboard metadata stores `null` for "My Workspace" reports, and
    // Zod `.optional()` would reject a literal null — `.nullish()` accepts both null and undefined.
    z.object({ groupId: z.string().min(1).nullish(), datasetId: z.string().min(1) }),
    async (p) => {
      const token = await accessToken();
      // Narrow to a non-empty string in a local so encodeURIComponent sees `string` (not nullish).
      const group =
        p.groupId === undefined || p.groupId === null || p.groupId === "" ? undefined : p.groupId;
      const datasetUrl =
        group === undefined
          ? `${POWERBI_API_BASE}/v1.0/myorg/datasets/${encodeURIComponent(p.datasetId)}/refreshes`
          : `${POWERBI_API_BASE}/v1.0/myorg/groups/${encodeURIComponent(group)}/datasets/${encodeURIComponent(p.datasetId)}/refreshes`;
      const res = await fetchWithTimeout(datasetUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notifyOption: "NoNotification" }),
      });
      if (!res.ok) {
        throw new Error(
          `Power BI dataset refresh ${String(res.status)}: ${(await res.text()).slice(0, 400)}`,
        );
      }
      return jsonResult({
        status: "queued",
        ...(group === undefined ? {} : { groupId: group }),
        datasetId: p.datasetId,
      });
    },
  );

  registerWriteTool(
    "powerbi_dataflow_refresh",
    {
      mutates: "powerbi.dataflow.refresh",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "workspace", value: p.groupId ?? "my-workspace" }),
    },
    "Trigger a dataflow refresh. Async (202).",
    z.object({ groupId: z.string().min(1), dataflowId: z.string().min(1) }),
    async (p) => {
      const token = await accessToken();
      const url = `${POWERBI_API_BASE}/v1.0/myorg/groups/${encodeURIComponent(p.groupId)}/dataflows/${encodeURIComponent(p.dataflowId)}/refreshes`;
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notifyOption: "NoNotification" }),
      });
      if (!res.ok) {
        throw new Error(
          `Power BI dataflow refresh ${String(res.status)}: ${(await res.text()).slice(0, 400)}`,
        );
      }
      return jsonResult({ status: "queued", groupId: p.groupId, dataflowId: p.dataflowId });
    },
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-powerbi", registerPowerBiTools);
}

if (import.meta.main) await startConnector();
