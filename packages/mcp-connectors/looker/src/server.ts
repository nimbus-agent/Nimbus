import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
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

/** GET a Looker collection as a bare array. With a `page`, adds `?limit&offset`; else the default page. */
async function getArray(
  token: string,
  path: string,
  page?: { limit: number; offset: number },
): Promise<unknown[]> {
  const base = apiBase();
  const qs = page === undefined ? "" : `?limit=${page.limit}&offset=${page.offset}`;
  const res = await fetchWithTimeout(`${base}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Looker ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

async function listDashboards(token: string): Promise<unknown[]> {
  return getArray(token, "/api/4.0/dashboards");
}

/** Resolve an opaque offset cursor; null / "" / undefined → 0. */
function offsetCursor(cursor: string | null | undefined): number {
  return cursor === null || cursor === undefined || cursor === ""
    ? 0
    : Math.max(0, Number.parseInt(cursor, 10) || 0);
}

export function registerLookerTools(reg: ZodToolRegistrar): void {
  reg(
    "looker_list",
    "List Looker dashboards (`GET /api/4.0/dashboards`). Requires a client-credentials login first. Paginated: `cursor` (opaque offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 200;
      const offset = offsetCursor(p.cursor);
      const token = await lookerLogin();
      const items = await getArray(token, "/api/4.0/dashboards", { limit, offset });
      return jsonResult({
        items,
        nextCursor: items.length === limit ? String(offset + limit) : null,
      });
    },
  );

  reg(
    "looker_models_list",
    "List LookML models (`GET /api/4.0/lookml_models`) for dashboard→table lineage. Paginated: `cursor` (opaque offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`. Returns raw models (explores/views nested); the gateway flattens them.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 200;
      const offset = offsetCursor(p.cursor);
      const token = await lookerLogin();
      const items = await getArray(token, "/api/4.0/lookml_models", { limit, offset });
      return jsonResult({
        items,
        nextCursor: items.length === limit ? String(offset + limit) : null,
      });
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
    searchToolInputSchema(200),
    async (p) => {
      const token = await lookerLogin();
      const dashboards = await listDashboards(token);
      const matches = filterLookerDashboards(dashboards, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  reg(
    "looker_datagroup_trigger",
    "Invalidate a Looker datagroup to force a PDT/cache rebuild (`PATCH /api/4.0/datagroups/{datagroupId}`). Sets `stale_before` to the current epoch so all cached results are considered stale. Requires HITL approval.",
    z.object({
      datagroupId: z.string().min(1),
    }),
    async (p) => {
      const token = await lookerLogin();
      const base = apiBase();
      const epochSeconds = Math.floor(Date.now() / 1000);
      const res = await fetchWithTimeout(
        `${base}/api/4.0/datagroups/${encodeURIComponent(p.datagroupId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ stale_before: epochSeconds }),
        },
      );
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Looker datagroup trigger ${res.status}: ${text.slice(0, 400)}`);
      }
      return jsonResult({ status: "ok", datagroupId: p.datagroupId });
    },
  );

  reg(
    "looker_schedule_run_once",
    "Run a Looker scheduled plan immediately (`POST /api/4.0/scheduled_plans/{scheduledPlanId}/run_once`). Triggers a one-off execution of the plan outside its normal schedule. Requires HITL approval.",
    z.object({
      scheduledPlanId: z.string().min(1),
    }),
    async (p) => {
      const token = await lookerLogin();
      const base = apiBase();
      const res = await fetchWithTimeout(
        `${base}/api/4.0/scheduled_plans/${encodeURIComponent(p.scheduledPlanId)}/run_once`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Looker schedule run_once ${res.status}: ${text.slice(0, 400)}`);
      }
      return jsonResult({ status: "queued", scheduledPlanId: p.scheduledPlanId });
    },
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-looker", registerLookerTools);
}

if (import.meta.main) await startConnector();
