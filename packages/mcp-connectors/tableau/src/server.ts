import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

// Live-query tools are stubs — the gateway-side tableau-sync.ts handles real
// Tableau REST API calls and populates the local index.  Wave 7a will wire
// these tools to live data once the MCP spawner injects credentials.

await runReadOnlyMcpConnector("nimbus-tableau", (reg) => {
  reg(
    "tableau_list",
    "List Tableau views/dashboards. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      return jsonResult({ items: [] });
    },
  );

  reg(
    "tableau_get",
    "Fetch one Tableau view by its luid.",
    z.object({
      id: z.string().min(1),
    }),
    async (_p) => {
      return jsonResult({ item: null });
    },
  );

  reg(
    "tableau_search",
    "Substring search across Tableau views. Matches the query (case-insensitive) against view name and luid. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (_p) => {
      return jsonResult({ matches: [] });
    },
  );
});
