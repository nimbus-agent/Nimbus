import type { MappedRow } from "./mapped-row.ts";

/**
 * Local data profiling (Tier-5, no-row-data). Profiles local data files
 * (`.parquet`, `.csv`, `.jsonl`, `.json`) into a `dataprofile:data_model`
 * IndexedItem carrying the SCHEMA only — column names/types, column count, a
 * row-count ESTIMATE, and file size.
 *
 * HARD SCOPE CONSTRAINT (security): this connector NEVER indexes cell values,
 * row samples, first-N-row previews, or header-row data values. Parquet schema
 * comes from the file footer (no row data crosses the wire); CSV column names
 * come from the header line; JSONL/JSON field names + JS types come from the
 * top-level structure (keys/types only, never the values). Types are only ever
 * the *kind* of a column, never a concrete value.
 *
 * NOTE on `provider`: the roadmap describes this under `provider = "filesystem"`,
 * but the existing `filesystem` service already emits code/repo items
 * (`git_commit` / `dependency` / `code_symbol`). To avoid two connectors sharing
 * one service id, this is a dedicated `dataprofile` service.
 */

export type DataFileFormat = "parquet" | "csv" | "jsonl" | "json";

export interface DataColumn {
  readonly name: string;
  /** Column kind (parquet physical type, or the JS type of a JSONL/JSON field). Null when unknown (CSV). */
  readonly type: string | null;
}

export interface DataModelProfile {
  readonly relativePath: string;
  readonly format: DataFileFormat;
  readonly columns: readonly DataColumn[];
  readonly rowCountEstimate: number | null;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number | null;
}

export interface DataProfileMappingContext {
  readonly syncedAt: number;
}

export type DataProfileMappedRow = MappedRow<"dataprofile", "data_model">;

const TITLE_MAX = 256;
const PREVIEW_MAX = 1000;
const MAX_COLUMNS = 512;
const SERVICE = "dataprofile" as const;
const TYPE = "data_model" as const;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function baseName(relativePath: string): string {
  const segments = relativePath.split(/[/\\]/);
  return segments.at(-1) ?? relativePath;
}

/** The JS "kind" of a value — name only, never the value itself. */
export function jsKind(v: unknown): string {
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v;
}

/**
 * Parse a CSV header line into column names. A simple comma split with optional
 * surrounding-quote stripping — heuristic (does not handle embedded quoted
 * commas), sufficient for column-NAME extraction. NEVER reads data rows.
 */
export function parseCsvHeader(firstLine: string): DataColumn[] {
  const line = firstLine.replace(/\r$/, "");
  if (line.trim() === "") {
    return [];
  }
  return line
    .split(",")
    .slice(0, MAX_COLUMNS)
    .map((raw) => {
      const name = raw
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
      return { name, type: null } satisfies DataColumn;
    });
}

/**
 * Extract field names + JS kinds from the first JSONL object. Reads ONLY the
 * keys + value KINDS of the first record — never stores any value. Returns []
 * if the line is not a JSON object.
 */
export function parseJsonlColumns(firstLine: string): DataColumn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  return Object.entries(parsed as Record<string, unknown>)
    .slice(0, MAX_COLUMNS)
    .map(([name, value]) => ({ name, type: jsKind(value) }) satisfies DataColumn);
}

/**
 * Profile a parsed JSON document's top-level shape. An array of objects → columns
 * from the first element + rowCount = array length; a single object → columns
 * from its keys, rowCount null. Reads keys + value KINDS only, never values.
 */
export function parseJsonColumns(parsed: unknown): {
  columns: DataColumn[];
  rowCountEstimate: number | null;
} {
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      return {
        columns: Object.entries(first as Record<string, unknown>)
          .slice(0, MAX_COLUMNS)
          .map(([name, value]) => ({ name, type: jsKind(value) })),
        rowCountEstimate: parsed.length,
      };
    }
    return { columns: [], rowCountEstimate: parsed.length };
  }
  if (typeof parsed === "object" && parsed !== null) {
    return {
      columns: Object.entries(parsed as Record<string, unknown>)
        .slice(0, MAX_COLUMNS)
        .map(([name, value]) => ({ name, type: jsKind(value) })),
      rowCountEstimate: null,
    };
  }
  return { columns: [], rowCountEstimate: null };
}

/** hyparquet metadata shape (the fields we read — schema + row count from the footer). */
export interface ParquetMetadataLike {
  readonly schema?: ReadonlyArray<{ name?: unknown; type?: unknown }>;
  readonly num_rows?: number | bigint;
}

/**
 * Extract columns + row count from parsed Parquet footer metadata. Leaf schema
 * elements (those with a physical `type`) are the columns; the root/group
 * elements (no `type`) are skipped. NO row data is read — this operates on the
 * footer metadata only.
 */
export function parquetColumnsFromMetadata(meta: ParquetMetadataLike): {
  columns: DataColumn[];
  rowCountEstimate: number | null;
} {
  const schema = Array.isArray(meta.schema) ? meta.schema : [];
  const columns: DataColumn[] = [];
  for (const el of schema) {
    if (el !== null && typeof el === "object" && typeof el.name === "string" && el.type != null) {
      columns.push({ name: el.name, type: String(el.type) });
      if (columns.length >= MAX_COLUMNS) {
        break;
      }
    }
  }
  const nr = meta.num_rows;
  const finiteRowCount = typeof nr === "number" && Number.isFinite(nr) ? nr : null;
  const rowCountEstimate = typeof nr === "bigint" ? Number(nr) : finiteRowCount;
  return { columns, rowCountEstimate };
}

/**
 * Pure mapper: a {@link DataModelProfile} → a `dataprofile:data_model`
 * IndexedItem. Stores the schema (column names/types), column count, row-count
 * estimate, and file size ONLY. Returns null for an empty path.
 */
export function mapDataModelToItem(
  profile: DataModelProfile,
  ctx: DataProfileMappingContext,
): DataProfileMappedRow | null {
  const relativePath = profile.relativePath.trim();
  if (relativePath === "") {
    return null;
  }

  const title = clamp(baseName(relativePath) || relativePath, TITLE_MAX);
  const columns = profile.columns.slice(0, MAX_COLUMNS);
  const colSummary = columns
    .map((c) => (c.type === null ? c.name : `${c.name}:${c.type}`))
    .join(", ");
  const rowText =
    profile.rowCountEstimate === null
      ? "rows unknown"
      : `~${String(profile.rowCountEstimate)} rows`;
  const bodyPreview = clamp(
    `${profile.format} · ${String(columns.length)} columns · ${rowText}\n${colSummary}`,
    PREVIEW_MAX,
  );

  const metadata: Record<string, unknown> = {
    relativePath,
    format: profile.format,
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    columnCount: columns.length,
    rowCountEstimate: profile.rowCountEstimate,
    sizeBytes: profile.sizeBytes,
  };

  return {
    service: SERVICE,
    type: TYPE,
    externalId: relativePath,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt: profile.modifiedAtMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
