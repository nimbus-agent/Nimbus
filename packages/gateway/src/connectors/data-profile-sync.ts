import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import {
  type DataColumn,
  type DataFileFormat,
  type DataModelProfile,
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
    return (await parquetMetadataAsync(buf)) as ParquetMetadataLike;
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
  const raw = (await readConnectorSecret(ctx.vault, "dataprofile", "dir"))?.trim() ?? "";
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

/** Read the first line + count newlines for a text file (≤ cap); larger files → header peek, rowCount null. */
async function readTextHeadAndRows(
  path: string,
  sizeBytes: number,
): Promise<{ firstLine: string; rowCountEstimate: number | null }> {
  if (sizeBytes <= MAX_TEXT_BYTES) {
    const text = (await readFile(path)).toString("utf8");
    const nl = (text.match(/\n/g) ?? []).length;
    const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    // Row estimate: newline count, minus a trailing-newline adjustment; never the data.
    const rows = text.endsWith("\n") ? nl : nl + 1;
    return { firstLine, rowCountEstimate: Math.max(0, rows) };
  }
  // Oversized: peek only the header, no row-count estimate.
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
): Promise<DataModelProfile | null> {
  let sizeBytes = 0;
  let modifiedAtMs: number | null = null;
  try {
    const info = await stat(path);
    sizeBytes = Number.isFinite(info.size) ? info.size : 0;
    modifiedAtMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
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
      const extracted = parquetColumnsFromMetadata(meta);
      columns = extracted.columns;
      rowCountEstimate = extracted.rowCountEstimate;
    } else if (format === "json") {
      if (sizeBytes > MAX_TEXT_BYTES) {
        return null; // too large to parse safely; skip
      }
      const parsed = JSON.parse((await readFile(path)).toString("utf8")) as unknown;
      const extracted = parseJsonColumns(parsed);
      columns = extracted.columns;
      rowCountEstimate = extracted.rowCountEstimate;
    } else {
      // csv / jsonl: header line + newline-based row estimate
      const { firstLine, rowCountEstimate: rows } = await readTextHeadAndRows(path, sizeBytes);
      columns = format === "csv" ? parseCsvHeader(firstLine) : parseJsonlColumns(firstLine);
      // CSV's first line is the header (not a data row); jsonl's first line IS a record.
      rowCountEstimate = format === "csv" && rows !== null ? Math.max(0, rows - 1) : rows;
    }
  } catch {
    return null; // unparseable / unreadable — skip, never throw
  }

  return { relativePath, format, columns, rowCountEstimate, sizeBytes, modifiedAtMs };
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
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), upserted);
    },
  };
}
