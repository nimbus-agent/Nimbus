import { open, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
const MAX_COLUMNS = 512;

export type DataFileFormat = "parquet" | "csv" | "jsonl" | "json";

const EXT_FORMAT: Record<string, DataFileFormat> = {
  ".parquet": "parquet",
  ".csv": "csv",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".json": "json",
};

export interface DataColumn {
  readonly name: string;
  readonly type: string | null;
}

export interface DataModel {
  readonly relativePath: string;
  readonly format: DataFileFormat;
  readonly columns: readonly DataColumn[];
  readonly columnCount: number;
  readonly rowCountEstimate: number | null;
  readonly sizeBytes: number;
}

export interface ParquetMetadataLike {
  readonly schema?: ReadonlyArray<{ name?: unknown; type?: unknown }>;
  readonly num_rows?: number | bigint;
}

export function jsKind(v: unknown): string {
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v;
}

export function parseCsvHeader(firstLine: string): DataColumn[] {
  const line = firstLine.replace(/\r$/, "");
  if (line.trim() === "") {
    return [];
  }
  return line
    .split(",")
    .slice(0, MAX_COLUMNS)
    .map(
      (raw) =>
        ({
          name: raw
            .trim()
            .replace(/^"(.*)"$/, "$1")
            .trim(),
          type: null,
        }) satisfies DataColumn,
    );
}

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
  const rowCountEstimate =
    typeof nr === "bigint" ? Number(nr) : typeof nr === "number" && Number.isFinite(nr) ? nr : null;
  return { columns, rowCountEstimate };
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
    return (await parquetMetadataAsync(buf)) as ParquetMetadataLike;
  } catch {
    return null;
  }
}

async function readTextHeadAndRows(
  path: string,
  sizeBytes: number,
): Promise<{ firstLine: string; rowCountEstimate: number | null }> {
  if (sizeBytes <= MAX_TEXT_BYTES) {
    const text = (await readFile(path)).toString("utf8");
    const nl = (text.match(/\n/g) ?? []).length;
    const idx = text.indexOf("\n");
    const firstLine = idx === -1 ? text : text.slice(0, idx);
    return { firstLine, rowCountEstimate: Math.max(0, text.endsWith("\n") ? nl : nl + 1) };
  }
  const fh = await open(path, "r");
  try {
    const { buffer, bytesRead } = await fh.read(
      Buffer.alloc(HEADER_PEEK_BYTES),
      0,
      HEADER_PEEK_BYTES,
      0,
    );
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const idx = chunk.indexOf("\n");
    return { firstLine: idx === -1 ? chunk : chunk.slice(0, idx), rowCountEstimate: null };
  } finally {
    await fh.close();
  }
}

async function profileFile(
  path: string,
  root: string,
  format: DataFileFormat,
  readParquet: ParquetMetadataReader,
): Promise<DataModel | null> {
  let sizeBytes = 0;
  try {
    const info = await stat(path);
    sizeBytes = Number.isFinite(info.size) ? info.size : 0;
  } catch {
    return null;
  }
  const relativePath = relative(root, path);
  let columns: DataColumn[] = [];
  let rowCountEstimate: number | null = null;
  try {
    if (format === "parquet") {
      const meta = await readParquet(path);
      if (meta === null) {
        return null;
      }
      ({ columns, rowCountEstimate } = parquetColumnsFromMetadata(meta));
    } else if (format === "json") {
      if (sizeBytes > MAX_TEXT_BYTES) {
        return null;
      }
      ({ columns, rowCountEstimate } = parseJsonColumns(
        JSON.parse((await readFile(path)).toString("utf8")) as unknown,
      ));
    } else {
      const { firstLine, rowCountEstimate: rows } = await readTextHeadAndRows(path, sizeBytes);
      columns = format === "csv" ? parseCsvHeader(firstLine) : parseJsonlColumns(firstLine);
      rowCountEstimate = format === "csv" && rows !== null ? Math.max(0, rows - 1) : rows;
    }
  } catch {
    return null;
  }
  return {
    relativePath,
    format,
    columns,
    columnCount: columns.length,
    rowCountEstimate,
    sizeBytes,
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
