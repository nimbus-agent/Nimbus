import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

// Live-query tools are stubs — the gateway-side looker-sync.ts handles real
// Looker API 4.0 calls and populates the local index.  Wave 7a will wire
// these tools to live data once the MCP spawner injects credentials.

await runReadOnlyMcpConnector("nimbus-looker", (reg) => {
  reg(
    "looker_list",
    "List Looker dashboards and LookML views. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      return jsonResult({ items: [] });
    },
  );

  reg(
    "looker_get",
    "Fetch one Looker dashboard or LookML view by its id.",
    z.object({
      id: z.string().min(1),
    }),
    async (_p) => {
      return jsonResult({ item: null });
    },
  );

  reg(
    "looker_search",
    "Substring search across Looker dashboards and LookML views. Matches the query (case-insensitive) against title, id, and model name. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (_p) => {
      return jsonResult({ matches: [] });
    },
  );
});
