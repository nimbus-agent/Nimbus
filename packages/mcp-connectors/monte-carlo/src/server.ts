import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
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

/**
 * Single POST helper for the Monte Carlo GraphQL endpoint. Sends `{ query, variables }` with the
 * `x-mcd-id`/`x-mcd-token` key-pair auth headers, throws on a non-ok HTTP status or a non-empty
 * GraphQL `errors` array, and returns the parsed top-level response object. Reused by every read
 * and write tool so auth + error handling stay in one place.
 */
async function mcGraphql(
  apiId: string,
  apiToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "x-mcd-id": apiId,
      "x-mcd-token": apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Monte Carlo API error ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = asObject(JSON.parse(text) as unknown) ?? {};
  const errors = parsed["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asObject(errors[0])?.["message"];
    const message = typeof first === "string" ? first : JSON.stringify(errors[0]);
    throw new Error(`Monte Carlo GraphQL error: ${message}`);
  }
  return parsed;
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
  const parsed = await mcGraphql(apiId, apiToken, GET_INCIDENTS_QUERY, { first, after });
  return parseIncidentsPage(parsed);
}

const SET_INCIDENT_FEEDBACK_MUTATION = `
  mutation NimbusSetIncidentFeedback($incidentId: UUID!, $feedback: IncidentFeedback!) {
    setIncidentFeedback(input: { incidentId: $incidentId, feedback: $feedback }) {
      __typename
    }
  }
`.trim();

/** Set the feedback/status on a Monte Carlo incident; throws on a GraphQL/HTTP error. */
async function setIncidentFeedback(
  apiId: string,
  apiToken: string,
  incidentId: string,
  feedback: "ACKNOWLEDGED" | "RESOLVED",
): Promise<void> {
  await mcGraphql(apiId, apiToken, SET_INCIDENT_FEEDBACK_MUTATION, { incidentId, feedback });
}

/** One page (up to 500) for `_get`/`_search`, which do not paginate. */
async function fetchIncidents(apiId: string, apiToken: string): Promise<unknown[]> {
  const page = await fetchIncidentsPage(apiId, apiToken, 500, null);
  return page.incidents;
}

export function registerMonteCarloTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "monte-carlo",
    scopeEnv: "NIMBUS_MCP_MONTE_CARLO_WRITE_SCOPE",
    scopeKinds: ["incident"],
  });

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
    searchToolInputSchema(200),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      const incidents = await fetchIncidents(apiId, apiToken);
      const matches = filterMonteCarloIncidents(incidents, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  registerWriteTool(
    "montecarlo_incident_acknowledge",
    {
      mutates: "montecarlo.incident.acknowledge",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "incident", value: p.incidentId }),
    },
    "Acknowledge a Monte Carlo incident.",
    z.object({ incidentId: z.string().min(1) }),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      await setIncidentFeedback(apiId, apiToken, p.incidentId, "ACKNOWLEDGED");
      return jsonResult({ status: "ok", incidentId: p.incidentId });
    },
  );

  registerWriteTool(
    "montecarlo_incident_resolve",
    {
      mutates: "montecarlo.incident.resolve",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "incident", value: p.incidentId }),
    },
    "Resolve a Monte Carlo incident.",
    z.object({ incidentId: z.string().min(1) }),
    async (p) => {
      const apiId = requireEnv("MONTECARLO_API_ID");
      const apiToken = requireEnv("MONTECARLO_API_TOKEN");
      await setIncidentFeedback(apiId, apiToken, p.incidentId, "RESOLVED");
      return jsonResult({ status: "ok", incidentId: p.incidentId });
    },
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-monte-carlo", registerMonteCarloTools);
}

if (import.meta.main) await startConnector();
