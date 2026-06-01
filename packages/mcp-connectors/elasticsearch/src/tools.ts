import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";

/**
 * Elasticsearch / Kibana (Tier-3, metadata-only) MCP tool surface. ALL tools
 * index schema / METADATA only — index names, health, status, document COUNTS,
 * store sizes, shard/replica counts, and field names + types from the index
 * mapping. NONE fetch document / row / hit data: no `_search`, no `_doc`, no
 * `_mget`, no `_sql`, no `_scroll`. `elasticsearch_search` searches index NAMES,
 * not document contents. The names are introspected by the `assertNoRowDataTools`
 * contract test, so they must never contain a row-data segment
 * (query/rows/sample/scan/preview/head/export/records/event/…).
 */
export const ELASTICSEARCH_TOOL_NAMES = [
  "elasticsearch_list",
  "elasticsearch_get",
  "elasticsearch_search",
] as const;

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function baseUrl(): string {
  const v = process.env["ELASTICSEARCH_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("ELASTICSEARCH_URL is not set");
  }
  return trimTrailingSlash(v);
}

function authHeaders(): Record<string, string> {
  const k = process.env["ELASTICSEARCH_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("ELASTICSEARCH_API_KEY is not set");
  }
  return { Authorization: `ApiKey ${k}`, Accept: "application/json" };
}

async function esGet(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Elasticsearch ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function indexEntries(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function indexMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return strField(entry, "index").toLowerCase().includes(q.toLowerCase());
}

/**
 * Register the read-only, metadata-only Elasticsearch tools onto the given
 * registrar. Shared between `server.ts` (live) and the contract test
 * (introspection).
 */
export function registerElasticsearchTools(reg: ZodToolRegistrar): void {
  reg(
    "elasticsearch_list",
    "List Elasticsearch indices — METADATA ONLY (`GET /_cat/indices?format=json&bytes=b`). Each entry carries the index name, `health` (green/yellow/red), `status` (open/close), `docs.count` (a single document COUNT integer — metadata, NOT documents), `store.size` (bytes), primary-shard count `pri`, replica count `rep`, and `uuid`. Never returns document/hit source.",
    z.object({}),
    async () => {
      return jsonResult({ items: indexEntries(await esGet("/_cat/indices?format=json&bytes=b")) });
    },
  );

  reg(
    "elasticsearch_get",
    "Fetch one index's field MAPPING (schema) — METADATA ONLY (`GET /<index>/_mapping`). Returns the mapping object `{ <index>: { mappings: { properties: { <field>: { type } } } } }` — field names + types only, NO document values. The index name is URL-path-encoded.",
    z.object({
      index: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await esGet(`/${encodeURIComponent(p.index)}/_mapping`));
    },
  );

  reg(
    "elasticsearch_search",
    "Substring search over index NAMES (case-insensitive) — METADATA ONLY. Lists indices via `GET /_cat/indices?format=json&bytes=b` and filters by name. Returns a `{ matches: [...] }` envelope of index metadata entries. This searches index names/metadata only and NEVER document contents — it does not run a query against documents.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const all = indexEntries(await esGet("/_cat/indices?format=json&bytes=b"));
      const filtered = all.filter((e) => indexMatches(e, p.query));
      const matches = p.limit === undefined ? filtered : filtered.slice(0, p.limit);
      return jsonResult({ matches });
    },
  );
}
