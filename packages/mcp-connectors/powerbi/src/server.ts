import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

await runReadOnlyMcpConnector("nimbus-powerbi", (reg) => {
  reg(
    "powerbi_list",
    "List Power BI reports. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      return jsonResult({ items: [] });
    },
  );

  reg(
    "powerbi_get",
    "Fetch one Power BI report by its id. Throws when the report is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      throw new Error(`Power BI report not found: ${p.id}`);
    },
  );

  reg(
    "powerbi_search",
    "Substring search across Power BI reports. Matches the query (case-insensitive) against report name. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (_p) => {
      return jsonResult({ matches: [] });
    },
  );
});
