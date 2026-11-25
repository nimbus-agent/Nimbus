/**
 * What a warehouse item says about its own columns, read from its metadata (Phase 10, the schema diff).
 *
 * Pure: no database, no clock. Two sources are tracked, each with its own completeness rule:
 * - `snowflake:data_model`: `metadata.columns` as the connector listed them, complete only when the connector
 *   said so (`columnsComplete === true`, from its `columns_complete`);
 * - `bigquery:table`: `metadata.schemaFields` (nested RECORD fields flattened to dotted paths), complete only
 *   when the table's schema was actually fetched (`schemaComplete === true`: a table beyond the per-dataset
 *   describe budget is listed with no schema at all).
 *
 * A column set longer than {@link SCHEMA_COLUMN_CAP} is incomplete, never silently cut.
 */

export type SchemaColumn = {
  readonly name: string;
  readonly type: string | null;
  readonly nullable: boolean | null;
};

export type SchemaObservation = {
  readonly service: string;
  readonly key: string;
  /** Sorted by name; `null` when the observation is incomplete. */
  readonly columns: readonly SchemaColumn[] | null;
};

/** At most this many columns are kept for one table; a longer set is recorded as incomplete. */
export const SCHEMA_COLUMN_CAP = 2000;

const SOURCES: ReadonlyMap<string, { columnsKey: string; completeKey: string }> = new Map([
  ["snowflake:data_model", { columnsKey: "columns", completeKey: "columnsComplete" }],
  ["bigquery:table", { columnsKey: "schemaFields", completeKey: "schemaComplete" }],
]);

export function isSchemaTracked(service: string, type: string): boolean {
  return SOURCES.has(`${service}:${type}`);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseColumns(raw: unknown): SchemaColumn[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SchemaColumn[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== "object") return null;
    const r = c as Record<string, unknown>;
    const name = asString(r["name"]);
    if (name === null || name === "") return null;
    out.push({
      name,
      type: asString(r["type"]),
      nullable: typeof r["nullable"] === "boolean" ? r["nullable"] : null,
    });
  }
  return out;
}

function byName(a: SchemaColumn, b: SchemaColumn): number {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/**
 * The observation an upserted item carries, or `undefined` when the pair is not tracked or the metadata names
 * no table key (nothing to key the history on). A tracked item whose columns cannot be trusted is an
 * INCOMPLETE observation, so the gap is recorded instead of nothing.
 */
export function schemaObservationOf(
  service: string,
  type: string,
  metadataJson: string,
): SchemaObservation | undefined {
  const source = SOURCES.get(`${service}:${type}`);
  if (source === undefined) return undefined;
  let meta: unknown;
  try {
    meta = JSON.parse(metadataJson);
  } catch {
    return undefined;
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const m = meta as Record<string, unknown>;
  const key = asString(m["dataModelKey"]);
  if (key === null || key === "" || key.length > 512) return undefined;
  const columns = parseColumns(m[source.columnsKey]);
  const complete = m[source.completeKey] === true;
  if (!complete || columns === null || columns.length > SCHEMA_COLUMN_CAP) {
    return { service, key, columns: null };
  }
  const seen = new Set<string>();
  for (const c of columns) {
    // Two columns with one name cannot be diffed by name: treat the observation as unproven.
    if (seen.has(c.name)) return { service, key, columns: null };
    seen.add(c.name);
  }
  return { service, key, columns: [...columns].sort(byName) };
}
