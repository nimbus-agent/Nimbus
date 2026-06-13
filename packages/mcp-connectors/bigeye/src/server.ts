import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

await runReadOnlyMcpConnector("nimbus-bigeye", (reg) => {
  reg(
    "bigeye_list",
    "List Bigeye data-quality issues. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      return jsonResult({ items: [] });
    },
  );

  reg(
    "bigeye_get",
    "Fetch one Bigeye data-quality issue by its id. Throws when the issue is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      throw new Error(`Bigeye issue not found: ${p.id}`);
    },
  );

  reg(
    "bigeye_search",
    "Substring search across Bigeye data-quality issues. Matches the query (case-insensitive) against issue summary. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (_p) => {
      return jsonResult({ matches: [] });
    },
  );
});
