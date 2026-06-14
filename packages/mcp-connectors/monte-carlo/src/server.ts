import { z } from "zod";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
import { filterMonteCarloIncidents } from "./search-filter.ts";

const GRAPHQL_URL = "https://api.getmontecarlo.com/graphql";

/**
 * Relay-paginated incidents query. `first`/`after` are passed as GraphQL *variables* (never string
 * interpolation) and `pageInfo` drives the cursor: `endCursor` becomes the next `after` while
 * `hasNextPage` is true.
 */
const GET_INCIDENTS_QUERY = `
  query NimbusGetIncidents($first: Int!, $after: String) {
    getIncidents(first: $first, after: $after) {
      edges {
        node {
          incidentId
          status
          severity
          firstSeenAt
          monitoredTable
        }
      }
      pageInfo {
        hasNextPage
        endCursor
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

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface IncidentsPage {
  readonly incidents: unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function parseIncidentsPage(parsed: unknown): IncidentsPage {
  const getIncidents = asObject(asObject(asObject(parsed)?.["data"])?.["getIncidents"]);
  const edges = Array.isArray(getIncidents?.["edges"]) ? (getIncidents["edges"] as unknown[]) : [];
  const incidents: unknown[] = [];
  for (const edge of edges) {
    const node = asObject(edge)?.["node"];
    if (node !== undefined) incidents.push(node);
  }
  const pageInfo = asObject(getIncidents?.["pageInfo"]);
  const hasNextPage = pageInfo?.["hasNextPage"] === true;
  const endCursor = typeof pageInfo?.["endCursor"] === "string" ? pageInfo["endCursor"] : null;
  return { incidents, hasNextPage, endCursor };
}

async function fetchIncidentsPage(
  apiId: string,
  apiToken: string,
  first: number,
  after: string | null,
): Promise<IncidentsPage> {
  const res = await fetchWithTimeout(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "x-mcd-id": apiId,
      "x-mcd-token": apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: GET_INCIDENTS_QUERY, variables: { first, after } }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Monte Carlo API error ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return parseIncidentsPage(JSON.parse(text) as unknown);
}

/** One page (up to 500) for `_get`/`_search`, which do not paginate. */
async function fetchIncidents(apiId: string, apiToken: string): Promise<unknown[]> {
  const page = await fetchIncidentsPage(apiId, apiToken, 500, null);
  return page.incidents;
}

export function registerMonteCarloTools(reg: ZodToolRegistrar): void {
  reg(
    "montecarlo_list",
    "List Monte Carlo data-quality incidents (relay GraphQL `getIncidents`). Paginated: `cursor` (the relay `after` token) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      const first = p.limit ?? 200;
      const after = p.cursor === undefined || p.cursor === "" ? null : p.cursor;
      const page = await fetchIncidentsPage(apiId, apiToken, first, after);
      const nextCursor = page.hasNextPage ? page.endCursor : null;
      return jsonResult({ items: page.incidents, nextCursor });
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
      const found = incidents.find((inc) => asObject(inc)?.["incidentId"] === p.id);
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
}

// Only connect a real stdio transport when run as the connector entrypoint (not when imported by tests).
if (import.meta.main) {
  await runReadOnlyMcpConnector("nimbus-monte-carlo", registerMonteCarloTools);
}
