import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import {
  type DataColumn,
  type DataFileFormat,
  type DataModelProfile,
  firstLineAndRows,
  mapDataModelToItem,
  type ParquetMetadataLike,
  parquetColumnsFromMetadata,
  parseCsvHeader,
  parseJsonColumns,
  parseJsonlColumns,
} from "./data-profile-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

// Local-only filesystem connector (Tier-5, no-row-data): profiles local data
// files into schema-only `dataprofile:data_model` items. No network.
const SERVICE_ID = "dataprofile";
const CURSOR_PREFIX = "nimbus-dataprofile1:";

const MAX_FILES = 2000;
const MAX_WALK_DEPTH = 12;
// Text formats are read whole (≤ cap) to count rows + take the header; larger
// files get a header-only peek with no row-count estimate. Never indexes values.
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const HEADER_PEEK_BYTES = 64 * 1024;

const EXT_FORMAT: Record<string, DataFileFormat> = {
  ".parquet": "parquet",
  ".csv": "csv",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".json": "json",
};

type DataProfileCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies DataProfileCursorV1);
}

/** Reads Parquet footer metadata (schema + row count) WITHOUT reading row data. Injectable for tests. */
export type ParquetMetadataReader = (path: string) => Promise<ParquetMetadataLike | null>;

async function defaultReadParquetMetadata(path: string): Promise<ParquetMetadataLike | null> {
  // hyparquet reads only the footer byte-range via the async buffer — no row data.
  const { asyncBufferFromFile, parquetMetadataAsync } = await import("hyparquet");
  try {
    const buf = await asyncBufferFromFile(path);
    return await parquetMetadataAsync(buf);
  } catch {
    return null;
  }
}

export type DataProfileSyncableOptions = {
  ensureDataprofileMcpRunning: () => Promise<void>;
  /** Injected Parquet footer reader (real over hyparquet in prod; fake in tests). */
  readParquetMetadata?: ParquetMetadataReader;
};

async function loadDir(ctx: SyncContext): Promise<string | null> {
  const raw = (await ctx.getSecret("dir"))?.trim() ?? "";
  return raw === "" ? null : resolve(raw);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

async function collectDataFiles(root: string): Promise<string[]> {
  const found: string[] = [];
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
      } else if (entry.isFile() && EXT_FORMAT[extOf(entry.name)] !== undefined) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}

interface FileSlurp {
  readonly text: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number | null;
  readonly truncated: boolean;
}

/**
 * Open the file ONCE and read its content + size + mtime from that single handle
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
    const modifiedAtMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
    if (sizeBytes <= MAX_TEXT_BYTES) {
      const buf = await fh.readFile();
      return { text: buf.toString("utf8"), sizeBytes, modifiedAtMs, truncated: false };
    }
    const { buffer, bytesRead } = await fh.read(
      Buffer.alloc(HEADER_PEEK_BYTES),
      0,
      HEADER_PEEK_BYTES,
      0,
    );
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      sizeBytes,
      modifiedAtMs,
      truncated: true,
    };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** fstat-only via an open handle (race-free) — for parquet, whose content hyparquet reads itself. */
async function statViaHandle(
  path: string,
): Promise<{ sizeBytes: number; modifiedAtMs: number | null } | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    return {
      sizeBytes: Number.isFinite(st.size) ? st.size : 0,
      modifiedAtMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : null,
    };
  } finally {
    await fh.close();
  }
}

/** Profile fields extracted from a file's content (path/format applied by the caller). */
interface ProfileFields {
  columns: DataColumn[];
  rowCountEstimate: number | null;
  sizeBytes: number;
  modifiedAtMs: number | null;
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
  const st = await statViaHandle(path);
  if (st === null) {
    return null;
  }
  return { columns, rowCountEstimate, sizeBytes: st.sizeBytes, modifiedAtMs: st.modifiedAtMs };
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
      return null; // too large to parse safely; skip
    }
    const { columns, rowCountEstimate } = parseJsonColumns(JSON.parse(slurp.text) as unknown);
    return {
      columns,
      rowCountEstimate,
      sizeBytes: slurp.sizeBytes,
      modifiedAtMs: slurp.modifiedAtMs,
    };
  }
  // csv / jsonl: header line + newline-based row estimate from the read text.
  const { firstLine, rowCountEstimate: rows } = firstLineAndRows(slurp.text, slurp.truncated);
  const columns = format === "csv" ? parseCsvHeader(firstLine) : parseJsonlColumns(firstLine);
  // CSV's first line is the header (not a data row); jsonl's first line IS a record.
  const rowCountEstimate = format === "csv" && rows !== null ? Math.max(0, rows - 1) : rows;
  return {
    columns,
    rowCountEstimate,
    sizeBytes: slurp.sizeBytes,
    modifiedAtMs: slurp.modifiedAtMs,
  };
}

async function profileFile(
  path: string,
  root: string,
  format: DataFileFormat,
  readParquet: ParquetMetadataReader,
): Promise<DataModelProfile | null> {
  const relativePath = relative(root, path);
  let fields: ProfileFields | null;
  try {
    fields =
      format === "parquet"
        ? await profileParquet(path, readParquet)
        : await profileTextFile(path, format);
  } catch {
    return null; // unparseable / unreadable — skip, never throw
  }
  if (fields === null) {
    return null;
  }
  return {
    relativePath,
    format,
    columns: fields.columns,
    rowCountEstimate: fields.rowCountEstimate,
    sizeBytes: fields.sizeBytes,
    modifiedAtMs: fields.modifiedAtMs,
  };
}

export function createDataProfileSyncable(options: DataProfileSyncableOptions): Syncable {
  const readParquet = options.readParquetMetadata ?? defaultReadParquetMetadata;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDataprofileMcpRunning();

      const dir = await loadDir(ctx);
      if (dir === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("filesystem");
      const now = Date.now();
      const files = await collectDataFiles(dir);
      let upserted = 0;
      for (const file of files) {
        const format = EXT_FORMAT[extOf(file)];
        if (format === undefined) {
          continue;
        }
        const profile = await profileFile(file, dir, format, readParquet);
        if (profile === null) {
          continue;
        }
        const mapped = mapDataModelToItem(profile, { syncedAt: now });
        if (mapped !== null) {
          ctx.upsertItem(mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), upserted);
    },
  };
}
