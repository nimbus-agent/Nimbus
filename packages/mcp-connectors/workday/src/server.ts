import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import {
  fetchWithTimeout,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
import { filterWorkdayWorkers } from "./search-filter.ts";

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const host = trimSlash(requireProcessEnv("WORKDAY_TENANT_HOST"));
  const tenant = requireProcessEnv("WORKDAY_TENANT");
  // Workday Staffing REST: /ccx/api/staffing/v6/<tenant>/workers
  return `${host}/ccx/api/staffing/v6/${encodeURIComponent(tenant)}`;
}

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireProcessEnv("WORKDAY_ACCESS_TOKEN")}`,
    Accept: "application/json",
  };
}

async function wdGet(path: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Workday ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function workersFrom(root: unknown): unknown[] {
  const d = (root as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? d : [];
}

export function registerWorkdayTools(reg: ZodToolRegistrar): void {
  reg(
    "workday_list",
    "List Workday workers (`GET /workers?limit=100`). Returns `{ data: [...] }` of worker objects (id, descriptor, title, team, department, location).",
    z.object({ limit: z.number().int().min(1).max(100).optional() }),
    async (p) => jsonResult(await wdGet(`/workers?limit=${p.limit ?? 100}`)),
  );

  reg(
    "workday_get",
    "Fetch one Workday worker by id (`GET /workers/{id}`).",
    z.object({ id: z.string().min(1) }),
    async (p) => jsonResult(await wdGet(`/workers/${encodeURIComponent(p.id)}`)),
  );

  reg(
    "workday_search",
    "Substring search across the first page of Workday workers (descriptor/title/team/department/location). Returns `{ matches: [...] }`.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await wdGet(`/workers?limit=100`);
      return jsonResult({
        matches: filterWorkdayWorkers(workersFrom(root), { query: p.query, limit: p.limit }),
      });
    },
  );
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-workday", registerWorkdayTools);
}

if (import.meta.main) await startConnector();
