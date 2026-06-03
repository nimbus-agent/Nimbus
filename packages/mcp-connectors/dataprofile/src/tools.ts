import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { type DataModel, filterDataModels, getDataModel, listDataModels } from "./profile.ts";

/**
 * Local data profiling MCP tool surface (Tier-5, no-row-data). Profiles local
 * data files into SCHEMA-only views — column names/types, column count,
 * row-count estimate, file size. NEVER returns cell values, row samples, or
 * first-N-row previews; the tool names carry no row-fetch/sample segment (the
 * `assertNoRowDataTools` contract test enforces this).
 */
export const DATAPROFILE_TOOL_NAMES = [
  "dataprofile_list",
  "dataprofile_get",
  "dataprofile_search",
] as const;

function toEnvelope(m: DataModel): Record<string, unknown> {
  return {
    relativePath: m.relativePath,
    format: m.format,
    columns: m.columns.map((c) => ({ name: c.name, type: c.type })),
    columnCount: m.columnCount,
    rowCountEstimate: m.rowCountEstimate,
    sizeBytes: m.sizeBytes,
  };
}

/**
 * Register the read-only data-profiling tools onto the given registrar. Shared
 * between `server.ts` (live) and the contract test (introspection).
 */
export function registerDataprofileTools(reg: ZodToolRegistrar): void {
  reg(
    "dataprofile_list",
    "List local data files (.parquet/.csv/.jsonl/.json) profiled under the configured dir. Returns each file's SCHEMA only — relative path, format, column names + types, column count, a row-count estimate, and file size. NEVER returns cell values, row samples, or row previews.",
    z.object({ limit: z.number().int().min(1).max(2000).optional() }),
    async (p) => {
      const all = await listDataModels();
      const limit = p.limit ?? 200;
      return jsonResult({ items: all.slice(0, limit).map(toEnvelope) });
    },
  );

  reg(
    "dataprofile_get",
    "Profile one local data file by its relative path (within the configured dir). Returns the SCHEMA only (columns + types + row-count estimate + size). NEVER returns cell values or row data.",
    z.object({ relativePath: z.string().min(1).max(1024) }),
    async (p) => {
      const m = await getDataModel(p.relativePath);
      return jsonResult(m === null ? { item: null } : { item: toEnvelope(m) });
    },
  );

  reg(
    "dataprofile_search",
    "Substring search over profiled data files (matches relative path, format, and column names). Returns the same schema-only view as dataprofile_list.",
    z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    async (p) => {
      const all = await listDataModels();
      const matches = filterDataModels(all, p.query).slice(0, p.limit ?? 200);
      return jsonResult({ matches: matches.map(toEnvelope) });
    },
  );
}
