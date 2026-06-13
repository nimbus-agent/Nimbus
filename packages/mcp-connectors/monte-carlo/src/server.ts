import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

function apiId(): string {
  const v = process.env["MONTECARLO_API_ID"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("MONTECARLO_API_ID is not set");
  }
  return v;
}

function apiToken(): string {
  const v = process.env["MONTECARLO_API_TOKEN"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("MONTECARLO_API_TOKEN is not set");
  }
  return v;
}

function authHeaders(): Record<string, string> {
  return {
    "x-mcd-id": apiId(),
    "x-mcd-token": apiToken(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

const GRAPHQL_URL = "https://api.getmontecarlo.com/graphql";

interface Incident {
  incidentId: string;
  status: string | null;
  severity: string | null;
  firstSeenAt: string | null;
  monitoredTable: string | null;
}

async function fetchIncidents(): Promise<Incident[]> {
  const query = `
    query NimbusListIncidents {
      getIncidents(first: 200) {
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
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Monte Carlo ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text) as {
    data?: { getIncidents?: { edges?: Array<{ node?: unknown }> } };
  };
  const edges = body.data?.getIncidents?.edges ?? [];
  const out: Incident[] = [];
  for (const edge of edges) {
    const node = edge.node;
    if (node === null || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const incidentId = typeof n["incidentId"] === "string" ? n["incidentId"] : null;
    if (incidentId === null || incidentId === "") continue;
    out.push({
      incidentId,
      status: typeof n["status"] === "string" ? n["status"] : null,
      severity: typeof n["severity"] === "string" ? n["severity"] : null,
      firstSeenAt: typeof n["firstSeenAt"] === "string" ? n["firstSeenAt"] : null,
      monitoredTable: typeof n["monitoredTable"] === "string" ? n["monitoredTable"] : null,
    });
  }
  return out;
}

function matchesQuery(incident: Incident, query: string): boolean {
  const q = query.toLowerCase();
  return (
    incident.incidentId.toLowerCase().includes(q) ||
    (incident.status ?? "").toLowerCase().includes(q) ||
    (incident.severity ?? "").toLowerCase().includes(q) ||
    (incident.monitoredTable ?? "").toLowerCase().includes(q)
  );
}

await runReadOnlyMcpConnector("nimbus-monte-carlo", (reg) => {
  reg(
    "montecarlo_list",
    "List Monte Carlo data-quality incidents. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const incidents = await fetchIncidents();
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
      const incidents = await fetchIncidents();
      const found = incidents.find((i) => i.incidentId === p.id);
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
      const incidents = await fetchIncidents();
      const matches = incidents.filter((i) => matchesQuery(i, p.query)).slice(0, p.limit ?? 50);
      return jsonResult({ matches });
    },
  );
});
