import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

// Real API calls and indexing are owned by the gateway-side monte-carlo-sync.ts.

await runReadOnlyMcpConnector("nimbus-monte-carlo", (reg) => {
  reg(
    "montecarlo_list",
    "List Monte Carlo data-quality incidents. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      return jsonResult({ items: [] });
    },
  );

  reg(
    "montecarlo_get",
    "Fetch one Monte Carlo incident by its id. Throws when the incident is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      throw new Error(`Monte Carlo incident not found: ${p.id}`);
    },
  );

  reg(
    "montecarlo_search",
    "Substring search across Monte Carlo incidents. Matches the query (case-insensitive) against incidentId, status, severity, and monitoredTable. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (_p) => {
      return jsonResult({ matches: [] });
    },
  );
});
