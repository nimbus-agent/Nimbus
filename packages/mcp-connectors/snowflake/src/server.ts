// Real indexing is performed by the gateway-side snowflake-sync.ts connector.
import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

await runReadOnlyMcpConnector("nimbus-snowflake", (reg) => {
  reg(
    "snowflake_list",
    "List Snowflake tables across all databases and schemas. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (_p) => {
      return jsonResult({ items: [] });
    },
  );

  reg(
    "snowflake_get",
    "Fetch one Snowflake table by its fully-qualified id (`database.schema.table`, case-insensitive). Throws when the table is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      throw new Error(`Snowflake table not found: ${p.id}`);
    },
  );

  reg(
    "snowflake_search",
    "Substring search across Snowflake tables. Matches the query (case-insensitive) against table name, schema name, and database name. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (_p) => {
      return jsonResult({ matches: [] });
    },
  );
});
