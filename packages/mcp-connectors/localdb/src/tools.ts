import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import {
  filterSavedQueries,
  getSavedQuery,
  type SavedQuery,
  scanSavedQueries,
} from "./sql-scan.ts";

/**
 * Local DB Schema Indexing MCP tool surface. Reads saved `.sql` queries from the
 * configured local DB-tool scripts dir — a pure filesystem read. No database is
 * connected to and no query is executed; the SQL TEXT is returned for recall.
 */
export const LOCALDB_TOOL_NAMES = ["localdb_list", "localdb_get", "localdb_search"] as const;

function toEnvelope(q: SavedQuery): Record<string, unknown> {
  return {
    relativePath: q.relativePath,
    title: q.title,
    sizeBytes: q.sizeBytes,
    lineCount: q.lineCount,
    sql: q.preview,
  };
}

/**
 * Register the read-only local-DB saved-query tools onto the given registrar.
 * Shared between `server.ts` (live) and the contract test (introspection).
 */
export function registerLocaldbTools(reg: ZodToolRegistrar): void {
  reg(
    "localdb_list",
    "List saved SQL queries read from the configured local DB-tool scripts directory (DBeaver/DataGrip/pgAdmin). Returns each query's relative path, title, size, line count, and SQL text. A pure filesystem read — no database is connected to and no query is executed.",
    z.object({ limit: z.number().int().min(1).max(500).optional() }),
    async (p) => {
      const all = await scanSavedQueries();
      const limit = p.limit ?? 100;
      return jsonResult({ items: all.slice(0, limit).map(toEnvelope) });
    },
  );

  reg(
    "localdb_get",
    "Fetch one saved SQL query by its relative path (within the configured scripts dir). Returns the SQL text + metadata. Never connects to a database.",
    z.object({ relativePath: z.string().min(1).max(1024) }),
    async (p) => {
      const q = await getSavedQuery(p.relativePath);
      return jsonResult(q === null ? { item: null } : { item: toEnvelope(q) });
    },
  );

  reg(
    "localdb_search",
    "Substring search over saved SQL queries (matches the title, relative path, and SQL text). Returns the same view as localdb_list. Searches local files only.",
    z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const all = await scanSavedQueries();
      const matches = filterSavedQueries(all, p.query).slice(0, p.limit ?? 100);
      return jsonResult({ matches: matches.map(toEnvelope) });
    },
  );
}
