import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type DataColumn,
  firstLineAndRows,
  type ParquetMetadataLike,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "@nimbus-dev/sdk";

/**
 * Local data profiling reader (Tier-5, no-row-data). The MCP-server-side
 * counterpart of the gateway's `mapDataModelToItem` mapper: it profiles local
 * data files (`.parquet`, `.csv`, `.jsonl`, `.json`) under the configured dir
 * into SCHEMA-only views — column names/types, column count, a row-count
 * ESTIMATE, file size.
 *
 * HARD SCOPE CONSTRAINT (security): NEVER reads cell values / row samples /
 * first-N-row previews. Parquet schema comes from the footer; CSV column names
 * from the header line; JSONL/JSON field names + JS kinds from the top-level
 * structure (keys/types only). A pure, bounded, path-traversal-guarded read.
 */

const MAX_FILES = 2000;
const MAX_WALK_DEPTH = 12;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const HEADER_PEEK_BYTES = 64 * 1024;

export type DataFileFormat = "parquet" | "csv" | "jsonl" | "json";

const EXT_FORMAT: Record<string, DataFileFormat> = {
  ".parquet": "parquet",
  ".csv": "csv",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".json": "json",
};

export { jsKind } from "@nimbus-dev/sdk";
export type { DataColumn, ParquetMetadataLike };
export { parquetColumnsFromMetadata, parseCsvHeader, parseJsonColumns, parseJsonlColumns };

export interface DataModel {
  readonly relativePath: string;
  readonly format: DataFileFormat;
  readonly columns: readonly DataColumn[];
  readonly columnCount: number;
  readonly rowCountEstimate: number | null;
  readonly sizeBytes: number;
}

export function dataDir(): string {
  const dir = process.env["DATAPROFILE_DIR"]?.trim();
  if (dir === undefined || dir === "") {
    throw new Error("DATAPROFILE_DIR is not set");
  }
  return resolve(dir);
}

export function assertWithinDataDir(candidate: string, root: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    return;
  }
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path escapes the configured data-profile dir");
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

/** Reads Parquet footer metadata (schema + row count) WITHOUT reading row data. Injectable for tests. */
export type ParquetMetadataReader = (path: string) => Promise<ParquetMetadataLike | null>;

async function readParquetMetadata(path: string): Promise<ParquetMetadataLike | null> {
  const { asyncBufferFromFile, parquetMetadataAsync } = await import("hyparquet");
  try {
    const buf = await asyncBufferFromFile(path);
    return await parquetMetadataAsync(buf);
  } catch {
    return null;
  }
}

interface FileSlurp {
  readonly text: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

/**
 * Open the file ONCE and read its content + size from that single handle
 * (`fh.stat()` + `fh.readFile()`/`fh.read()`). Operating on one open descriptor
 * avoids a check-then-use (TOCTOU) race — there is no window where the path is
 * stat-ed and then re-opened. Whole content for files ≤ cap; a header-only peek
 * (no row-count estimate) for larger files.
 */
async function slurpFile(path: string): Promise<FileSlurp | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    const sizeBytes = Number.isFinite(st.size) ? st.size : 0;
    if (sizeBytes <= MAX_TEXT_BYTES) {
      const buf = await fh.readFile();
      return { text: buf.toString("utf8"), sizeBytes, truncated: false };
    }
    const { buffer, bytesRead } = await fh.read(
      Buffer.alloc(HEADER_PEEK_BYTES),
      0,
      HEADER_PEEK_BYTES,
      0,
    );
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), sizeBytes, truncated: true };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** fstat-only via an open handle (race-free) — for parquet, whose content hyparquet reads itself. */
async function sizeViaHandle(path: string): Promise<number | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    return Number.isFinite(st.size) ? st.size : 0;
  } finally {
    await fh.close();
  }
}

/** Profile fields extracted from a file's content (path/format applied by the caller). */
interface ProfileFields {
  columns: DataColumn[];
  rowCountEstimate: number | null;
  sizeBytes: number;
}

async function profileParquet(
  path: string,
  readParquet: ParquetMetadataReader,
): Promise<ProfileFields | null> {
  const meta = await readParquet(path);
  if (meta === null) {
    return null;
  }
  const { columns, rowCountEstimate } = parquetColumnsFromMetadata(meta);
  const size = await sizeViaHandle(path);
  if (size === null) {
    return null;
  }
  return { columns, rowCountEstimate, sizeBytes: size };
}

async function profileTextFile(
  path: string,
  format: Exclude<DataFileFormat, "parquet">,
): Promise<ProfileFields | null> {
  const slurp = await slurpFile(path);
  if (slurp === null) {
    return null;
  }
  if (format === "json") {
    if (slurp.truncated) {
      return null;
    }
    const { columns, rowCountEstimate } = parseJsonColumns(JSON.parse(slurp.text) as unknown);
    return { columns, rowCountEstimate, sizeBytes: slurp.sizeBytes };
  }
  const { firstLine, rowCountEstimate: rows } = firstLineAndRows(slurp.text, slurp.truncated);
  const columns = format === "csv" ? parseCsvHeader(firstLine) : parseJsonlColumns(firstLine);
  const rowCountEstimate = format === "csv" && rows !== null ? Math.max(0, rows - 1) : rows;
  return { columns, rowCountEstimate, sizeBytes: slurp.sizeBytes };
}

async function profileFile(
  path: string,
  root: string,
  format: DataFileFormat,
  readParquet: ParquetMetadataReader,
): Promise<DataModel | null> {
  const relativePath = relative(root, path);
  let fields: ProfileFields | null;
  try {
    fields =
      format === "parquet"
        ? await profileParquet(path, readParquet)
        : await profileTextFile(path, format);
  } catch {
    return null;
  }
  if (fields === null) {
    return null;
  }
  return {
    relativePath,
    format,
    columns: fields.columns,
    columnCount: fields.columns.length,
    rowCountEstimate: fields.rowCountEstimate,
    sizeBytes: fields.sizeBytes,
  };
}

async function collectDataFiles(
  root: string,
): Promise<Array<{ path: string; format: DataFileFormat }>> {
  const found: Array<{ path: string; format: DataFileFormat }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const format = EXT_FORMAT[extOf(entry.name)];
        if (format !== undefined) {
          found.push({ path: full, format });
        }
      }
    }
  }
  await walk(root, 0);
  return found;
}

/** Profile all data files under the configured dir into schema-only `DataModel` views. */
export async function listDataModels(
  readParquet: ParquetMetadataReader = readParquetMetadata,
): Promise<DataModel[]> {
  const root = dataDir();
  const files = await collectDataFiles(root);
  const out: DataModel[] = [];
  for (const { path, format } of files) {
    assertWithinDataDir(path, root);
    const model = await profileFile(path, root, format, readParquet);
    if (model !== null) {
      out.push(model);
    }
  }
  return out;
}

/** Profile one data file by its relative path (path-guarded). */
export async function getDataModel(
  relativePath: string,
  readParquet: ParquetMetadataReader = readParquetMetadata,
): Promise<DataModel | null> {
  const root = dataDir();
  const candidate = resolve(root, relativePath);
  assertWithinDataDir(candidate, root);
  const format = EXT_FORMAT[extOf(candidate)];
  if (format === undefined) {
    return null;
  }
  return profileFile(candidate, root, format, readParquet);
}

/** Substring search over data-model relative path / format / column names. */
export function filterDataModels(models: readonly DataModel[], query: string): DataModel[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [...models];
  }
  return models.filter(
    (m) =>
      m.relativePath.toLowerCase().includes(q) ||
      m.format.includes(q) ||
      m.columns.some((c) => c.name.toLowerCase().includes(q)),
  );
}
