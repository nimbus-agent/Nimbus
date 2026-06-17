import { z } from "zod";
import { type McpListResult, mcpJsonResult, type ZodObjectSchema } from "./mcp-tool-kit.ts";
import type { SearchMatchOptions } from "./search-filter.ts";

/** A `makeQueryFilter(...)` result — the shape every connector search filter has. */
export type SearchFilter = (
  rows: readonly unknown[],
  opts: SearchMatchOptions,
) => readonly unknown[];

/**
 * Build the shared connector search input schema. `query` is always a non-empty
 * string; `maxLimit` is the per-connector cap (varies: 100/200/500/50/1000/2000)
 * and MUST be passed verbatim from each call site so behavior is unchanged.
 */
export function searchToolInputSchema(maxLimit = 100): ZodObjectSchema<SearchMatchOptions> {
  return z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(maxLimit).optional(),
  });
}

/**
 * Build the `{ matches }` envelope: filter the rows when they are an array, else
 * return an empty match set. Verbatim equivalent of the per-connector tail
 * `const matches = Array.isArray(X) ? filter(X, { query, limit }) : []; return jsonResult({ matches })`.
 * `rows` stays `unknown` because external payloads are untyped at the boundary
 * (Non-Negotiable #7).
 */
export function matchesResult(
  rows: unknown,
  filter: SearchFilter,
  opts: SearchMatchOptions,
): McpListResult {
  const matches = Array.isArray(rows) ? filter(rows, opts) : [];
  return mcpJsonResult({ matches });
}
