import type { IndexSearchQuery } from "../index/local-index.ts";

const MAX_TOOL_STRING_LEN = 2000;

export function clipToolString(s: string, max = MAX_TOOL_STRING_LEN): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** A model-supplied string argument, trimmed and clipped; `undefined` when absent or blank. */
function clippedString(value: unknown): string | undefined {
  return typeof value === "string" ? clipToolString(value.trim()) || undefined : undefined;
}

/** A model-supplied integer argument clamped to `[min, max]`; `fallback` when not a finite number. */
function clampedInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

/** What `searchLocalIndex` takes from the model's arguments: the query and its two knobs. */
export type SearchLocalIndexArgs = {
  readonly query: IndexSearchQuery;
  readonly service: string | undefined;
  readonly semantic: boolean;
  readonly contextChunks: number;
};

/** Reads the `searchLocalIndex` arguments; the point-in-time instant is never one of them. */
export function parseSearchLocalIndexArgs(q: Record<string, unknown>): SearchLocalIndexArgs {
  const name = clippedString(q["name"]);
  const service = clippedString(q["service"]);
  const itemType = clippedString(q["itemType"]);
  const query: IndexSearchQuery = { limit: clampedInt(q["limit"], 1, 500, 20) };
  if (name !== undefined) query.name = name;
  if (service !== undefined) query.service = service;
  if (itemType !== undefined) query.itemType = itemType;
  return {
    query,
    service,
    semantic: q["semantic"] !== false,
    contextChunks: clampedInt(q["contextChunks"], 0, 8, 2),
  };
}
