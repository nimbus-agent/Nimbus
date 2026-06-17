import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { encodeBasicAuthHeader, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterAirflowDags } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["AIRFLOW_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("AIRFLOW_URL is not set");
  }
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const user = process.env["AIRFLOW_USERNAME"]?.trim();
  if (user === undefined || user === "") {
    throw new Error("AIRFLOW_USERNAME is not set");
  }
  const password = process.env["AIRFLOW_PASSWORD"]?.trim();
  if (password === undefined || password === "") {
    throw new Error("AIRFLOW_PASSWORD is not set");
  }
  return {
    Authorization: encodeBasicAuthHeader(user, password),
    Accept: "application/json",
  };
}

async function airflowGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Airflow ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function dagsFrom(root: unknown): unknown[] {
  const dags = (root as { dags?: unknown } | null)?.dags;
  return Array.isArray(dags) ? dags : [];
}

await runReadOnlyMcpConnector("nimbus-airflow", (reg) => {
  reg(
    "airflow_list",
    "List Airflow DAGs (GET /api/v1/dags?limit=100&offset=<n>). The Airflow stable REST API v1 returns the envelope { dags: [...], total_entries: <int> } — `dags` holds the DAG objects, `total_entries` the total across all pages. The optional offset arg (default 0) selects the page start; limit is fixed at 100.",
    z.object({
      offset: z.number().int().min(0).optional(),
    }),
    async (p) => {
      const offset = p.offset ?? 0;
      const root = await airflowGet(
        `/api/v1/dags?limit=100&offset=${encodeURIComponent(String(offset))}`,
      );
      return jsonResult({ items: dagsFrom(root) });
    },
  );

  reg(
    "airflow_get",
    "Fetch one Airflow DAG by its dag_id (GET /api/v1/dags/{dag_id}). Returns the DAG object directly (NOT wrapped in an envelope). Throws when no DAG with that id exists.",
    z.object({
      dag_id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await airflowGet(`/api/v1/dags/${encodeURIComponent(p.dag_id)}`));
    },
  );

  reg(
    "airflow_search",
    "Substring search across the first page of Airflow DAGs. Matches the query (case-insensitive) against the dag_id, description, owners, and tag names. Returns a matches envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await airflowGet("/api/v1/dags?limit=100&offset=0");
      const matches = filterAirflowDags(dagsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
