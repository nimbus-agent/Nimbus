import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface ElasticsearchMappingContext {
  /** Field names + types flattened from the index `_mapping` (SCHEMA metadata, NO values). */
  readonly fields: ReadonlyArray<{ name: string; type: string }>;
  readonly syncedAt: number;
}

export type ElasticsearchMappedRow = MappedRow<"elasticsearch", "index">;

const TITLE_MAX = 256;
const BODY_MAX = 512;

/**
 * `_cat/indices?format=json&bytes=b` returns string-valued numeric columns
 * (e.g. `"docs.count": "1234"`, `"store.size": "987654"`, `pri: "1"`). Parse to
 * a finite number; null when absent or unparseable.
 */
function parseCatNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read a string column from a `_cat/indices` row, tolerating missing values. */
function catString(row: Record<string, unknown>, key: string): string | null {
  const v = stringField(row, key);
  return v !== undefined && v !== "" ? v : null;
}

/**
 * Walk an Elasticsearch `_mapping` response into a flat list of field
 * name + type pairs — SCHEMA metadata only, NO document values. ES nests object
 * fields under `properties`; we flatten using dotted paths so the field shape is
 * searchable without storing any data.
 *
 * Input shape: `{ <index>: { mappings: { properties: { <field>: { type?, properties? } } } } }`.
 * The top-level index key is unwrapped (single-index `_mapping` calls return one
 * key); `mappings.properties` is the field tree.
 */
export function flattenMappingFields(
  mapping: unknown,
  indexName: string,
): Array<{ name: string; type: string }> {
  const root = asRecord(mapping);
  if (root === undefined) {
    return [];
  }
  // Prefer the entry keyed by the index name; return [] when the requested index name is absent
  const indexBlock = asRecord(root[indexName]);
  if (indexBlock === undefined) {
    return [];
  }
  const mappings = asRecord(indexBlock["mappings"]);
  if (mappings === undefined) {
    return [];
  }
  return flattenProperties(mappings["properties"], "");
}

function flattenProperties(
  properties: unknown,
  prefix: string,
): Array<{ name: string; type: string }> {
  const props = asRecord(properties);
  if (props === undefined) {
    return [];
  }
  const out: Array<{ name: string; type: string }> = [];
  for (const [fieldName, raw] of Object.entries(props)) {
    if (fieldName === "") {
      continue;
    }
    const fr = asRecord(raw);
    const path = prefix === "" ? fieldName : `${prefix}.${fieldName}`;
    const type = fr === undefined ? "" : (stringField(fr, "type") ?? "");
    if (fr?.["properties"] === undefined) {
      out.push({ name: path, type });
    } else {
      // An object/nested field — has children but typically no own `type`.
      out.push(
        { name: path, type: type === "" ? "object" : type },
        ...flattenProperties(fr["properties"], path),
      );
    }
  }
  return out;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pure mapper: an Elasticsearch `_cat/indices` row + flattened mapping fields →
 * IndexedItem. Stores index METADATA only — index name, health, status, document
 * COUNT, store size, shard/replica counts, UUID, and field names/types. NEVER
 * document contents. Returns null when the row carries no index name.
 *
 * `external_id` is the index `index` name (host-scoping is intentionally omitted
 * for simplicity; a single Nimbus profile points at one cluster).
 */
export function mapElasticsearchIndexToItem(
  catRow: unknown,
  ctx: ElasticsearchMappingContext,
): ElasticsearchMappedRow | null {
  const row = asRecord(catRow);
  if (row === undefined) {
    return null;
  }

  const index = catString(row, "index");
  if (index === null) {
    return null;
  }

  const health = catString(row, "health");
  const status = catString(row, "status");
  const docsCount = parseCatNumber(row["docs.count"]);
  const storeSizeBytes = parseCatNumber(row["store.size"]);
  const primaryShards = parseCatNumber(row["pri"]);
  const replicas = parseCatNumber(row["rep"]);
  const uuid = catString(row, "uuid");

  const fields = ctx.fields.map((f) => ({ name: f.name, type: f.type }));

  const title = clamp(index, TITLE_MAX);
  const healthLabel = health ?? "unknown";
  const statusLabel = status ?? "unknown";
  const countLabel = docsCount === null ? "?" : String(docsCount);
  const fieldSummary = fields.length > 0 ? fields.map((f) => `${f.name}:${f.type}`).join(", ") : "";
  const summary = `${index} [${healthLabel}/${statusLabel}, ${countLabel} docs]`;
  const bodyPreview = clamp(
    fieldSummary === "" ? summary : `${summary} — ${fieldSummary}`,
    BODY_MAX,
  );

  // `_cat/indices` has no reliable mtime; use the sync timestamp.
  const modifiedAt = ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    index,
    health,
    status,
    docsCount,
    storeSizeBytes,
    primaryShards,
    replicas,
    uuid,
    fields,
  };

  return {
    service: "elasticsearch",
    type: "index",
    externalId: index,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
