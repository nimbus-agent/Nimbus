import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterMonteCarloIncidents } from "./search-filter.ts";

const GRAPHQL_URL = "https://api.getmontecarlo.com/graphql";

const GET_INCIDENTS_QUERY = `
  query NimbusGetIncidents {
    getIncidents(first: 500) {
      edges {
        node {
          incidentId
          status
          severity
          firstSeenAt
          monitoredTable
        }
      }
    }
  }
`.trim();

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set`);
  }
  return v;
}

function incidentsFromResponse(parsed: unknown): unknown[] {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const root = parsed as Record<string, unknown>;
  const data = root["data"];
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const dataObj = data as Record<string, unknown>;
  const getIncidents = dataObj["getIncidents"];
  if (getIncidents === null || typeof getIncidents !== "object" || Array.isArray(getIncidents))
    return [];
  const incObj = getIncidents as Record<string, unknown>;
  const edges = incObj["edges"];
  if (!Array.isArray(edges)) return [];
  const out: unknown[] = [];
  for (const edge of edges) {
    if (edge === null || typeof edge !== "object" || Array.isArray(edge)) continue;
    const node = (edge as Record<string, unknown>)["node"];
    if (node !== undefined) out.push(node);
  }
  return out;
}

async function fetchIncidents(apiId: string, apiToken: string): Promise<unknown[]> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "x-mcd-id": apiId,
      "x-mcd-token": apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: GET_INCIDENTS_QUERY }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Monte Carlo API error ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return incidentsFromResponse(JSON.parse(text) as unknown);
}

await runReadOnlyMcpConnector("nimbus-monte-carlo", (reg) => {
  reg(
    "montecarlo_list",
    "List Monte Carlo data-quality incidents. `limit` (default 200, max 500) caps the returned list client-side.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      const incidents = await fetchIncidents(apiId, apiToken);
      const cap = p.limit ?? 200;
      return jsonResult({ items: incidents.slice(0, cap) });
    },
  );

  reg(
    "montecarlo_get",
    "Fetch one Monte Carlo incident by its id. Throws when the incident is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      const incidents = await fetchIncidents(apiId, apiToken);
      const found = incidents.find((inc) => {
        if (inc === null || typeof inc !== "object" || Array.isArray(inc)) return false;
        return (inc as Record<string, unknown>)["incidentId"] === p.id;
      });
      if (found === undefined) {
        throw new Error(`Monte Carlo incident not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "montecarlo_search",
    "Substring search across Monte Carlo incidents. Matches the query (case-insensitive) against incidentId, status, severity, and monitoredTable. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      const incidents = await fetchIncidents(apiId, apiToken);
      const matches = filterMonteCarloIncidents(incidents, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
