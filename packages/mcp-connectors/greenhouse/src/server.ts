import { z } from "zod";
import { encodeBasicAuthHeader, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterGreenhouseJobs } from "./search-filter.ts";

const BASE = "https://harvest.greenhouse.io";

function apiKey(): string {
  const t = process.env["GREENHOUSE_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("GREENHOUSE_API_KEY is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: encodeBasicAuthHeader(apiKey(), ""), Accept: "application/json" };
}

async function greenhouseGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Greenhouse ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-greenhouse", (reg) => {
  reg(
    "greenhouse_list",
    "List the company's Greenhouse Harvest job openings (`GET /v1/jobs?per_page=100`). Returns a bare JSON array of job objects (NOT an envelope), each carrying the name, status, requisition id, departments, and offices.",
    z.object({
      per_page: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ per_page: String(p.per_page ?? 100), page: "1" });
      return jsonResult(await greenhouseGet(`/v1/jobs?${search.toString()}`));
    },
  );

  reg(
    "greenhouse_get",
    "Fetch one Greenhouse job by its id (`GET /v1/jobs/{id}`). Returns the job object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await greenhouseGet(`/v1/jobs/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "greenhouse_search",
    "Substring search across the company's Greenhouse job openings (first page only). Matches the query against the job name, status, requisition id, the department names, and the office names + locations (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const search = new URLSearchParams({ per_page: "100", page: "1" });
      const root = await greenhouseGet(`/v1/jobs?${search.toString()}`);
      const matches = Array.isArray(root)
        ? filterGreenhouseJobs(root, { query: p.query, limit: p.limit })
        : [];
      return jsonResult({ matches });
    },
  );
});
