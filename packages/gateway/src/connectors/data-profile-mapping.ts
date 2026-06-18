import {
  type DataColumn,
  firstLineAndRows,
  jsKind,
  type ParquetMetadataLike,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "@nimbus-dev/sdk";
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

export type { DataColumn, ParquetMetadataLike };
export {
  firstLineAndRows,
  jsKind,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
};

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
