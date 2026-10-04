import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { itemPrimaryKey } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { collectFiles } from "./_lib/collect-files.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import {
  type GreatExpectationsMappingContext,
  legacyClampedExternalId,
  mapGreatExpectationsResultToItem,
} from "./great-expectations-result-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

// connectorFetch opt-out: indexes filesystem GX validation-result JSON
// artefacts, not paginated HTTP.
const SERVICE_ID = "great_expectations";
const CURSOR_PREFIX = "nimbus-gx1:";

// Walk caps — a bad/oversized/unparseable file is skipped, never fatal.
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WALK_DEPTH = 12;

type GxCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies GxCursorV1);
}

export type GreatExpectationsSyncableOptions = {
  ensureGreatExpectationsMcpRunning: () => Promise<void>;
};

async function loadResultsDir(ctx: SyncContext): Promise<string | null> {
  const raw = (await ctx.getSecret("results_dir"))?.trim() ?? "";
  return raw === "" ? null : resolve(raw);
}

function deriveRunId(meta: Record<string, unknown>): string | null {
  const runId = meta["run_id"];
  if (typeof runId === "string" && runId !== "") {
    return runId;
  }
  const rec = asRecord(runId);
  if (rec !== undefined) {
    return stringField(rec, "run_name") ?? stringField(rec, "run_time") ?? null;
  }
  return null;
}

function deriveRunTime(meta: Record<string, unknown>): string | null {
  const rec = asRecord(meta["run_id"]);
  if (rec !== undefined) {
    const rt = stringField(rec, "run_time");
    if (rt !== undefined && rt !== "") {
      return rt;
    }
  }
  return stringField(meta, "run_time") ?? stringField(meta, "validation_time") ?? null;
}

function deriveBatchId(meta: Record<string, unknown>): string {
  const direct = stringField(meta, "batch_id") ?? stringField(meta, "active_batch_definition_id");
  if (direct !== undefined && direct !== "") {
    return direct;
  }
  const def = asRecord(meta["active_batch_definition"]);
  if (def !== undefined) {
    const name =
      stringField(def, "batch_identifiers") ??
      stringField(def, "data_asset_name") ??
      stringField(def, "datasource_name");
    if (name !== undefined && name !== "") {
      return name;
    }
  }
  const spec = asRecord(meta["batch_spec"]);
  if (spec !== undefined) {
    const p = stringField(spec, "path") ?? stringField(spec, "table_name");
    if (p !== undefined && p !== "") {
      return p;
    }
  }
  return "_";
}

function buildMappingContext(
  parsed: Record<string, unknown>,
  syncedAt: number,
  fileModifiedAt: number | null,
): GreatExpectationsMappingContext {
  const meta = asRecord(parsed["meta"]) ?? {};
  const statistics = asRecord(parsed["statistics"]) ?? {};
  return {
    suiteName: stringField(meta, "expectation_suite_name") ?? "_",
    batchId: deriveBatchId(meta),
    runId: deriveRunId(meta),
    runTime: deriveRunTime(meta),
    successPercent: numberField(statistics, "success_percent") ?? null,
    syncedAt,
    fileModifiedAt,
  };
}

function collectJsonFiles(root: string): Promise<string[]> {
  return collectFiles(root, {
    maxDepth: MAX_WALK_DEPTH,
    maxFiles: MAX_FILES,
    accept: (name) => name.toLowerCase().endsWith(".json"),
  });
}

interface ParsedArtefact {
  readonly parsed: Record<string, unknown>;
  readonly mtimeMs: number | null;
}

async function readArtefact(path: string): Promise<ParsedArtefact | null> {
  try {
    // Read first (no check-then-use race): readFile throws on a directory
    // (EISDIR) or a missing/unreadable file, and the size is bounded by the
    // returned buffer — so no `stat`-gated read window exists.
    const buf = await readFile(path);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return null;
    }
    const json = JSON.parse(buf.toString("utf8")) as unknown;
    const rec = asRecord(json);
    if (rec === undefined) {
      return null;
    }
    // mtime is non-essential metadata; fetch it best-effort and tolerate a
    // concurrent change (it does not gate the read above).
    let mtimeMs: number | null = null;
    try {
      const info = await stat(path);
      mtimeMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
    } catch {
      mtimeMs = null;
    }
    return { parsed: rec, mtimeMs };
  } catch {
    return null; // missing / oversized / unparseable — skip, never throw
  }
}

/** The rows one sync pass wrote, and the pre-fix ids of the same results. */
interface PassIds {
  /**
   * The PRIMARY KEY of every row written, the key `itemExists` and `deleteItem` act on. Not the
   * external id: `itemPrimaryKey` keeps an id that already starts with `great_expectations:` as it
   * is, so two different external ids can name the same row.
   */
  readonly written: Set<string>;
  /** External ids, as `legacyClampedExternalId` derives them. */
  readonly legacy: Set<string>;
}

function ingestArtefact(
  ctx: SyncContext,
  artefact: ParsedArtefact,
  syncedAt: number,
  ids: PassIds,
): number {
  const results = artefact.parsed["results"];
  if (!Array.isArray(results)) {
    return 0;
  }
  const mappingCtx = buildMappingContext(artefact.parsed, syncedAt, artefact.mtimeMs);
  for (const entry of results) {
    const legacy = legacyClampedExternalId(entry, mappingCtx);
    if (legacy !== null) ids.legacy.add(legacy);
  }
  return upsertMapped(ctx, results, (entry) => {
    const row = mapGreatExpectationsResultToItem(entry, mappingCtx);
    if (row !== null) ids.written.add(itemPrimaryKey(SERVICE_ID, row.externalId));
    return row;
  });
}

/**
 * Removes the rows an older gateway wrote under a broken clamped id (see
 * `legacyClampedExternalId`) for results this pass has just written under their real ids. Runs
 * after every artefact is ingested and skips any row this pass wrote, compared by primary key, so
 * it can never remove a row that is current. Returns how many rows it removed.
 */
function removeLegacyClampedRows(ctx: SyncContext, ids: PassIds): number {
  let removed = 0;
  for (const id of ids.legacy) {
    const key = itemPrimaryKey(SERVICE_ID, id);
    if (ids.written.has(key) || !ctx.itemExists(key)) continue;
    ctx.deleteItem(SERVICE_ID, id);
    removed += 1;
  }
  return removed;
}

export function createGreatExpectationsSyncable(
  options: GreatExpectationsSyncableOptions,
): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGreatExpectationsMcpRunning();

      const dir = await loadResultsDir(ctx);
      if (dir === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("filesystem");
      const now = Date.now();
      const files = await collectJsonFiles(dir);
      const ids: PassIds = { written: new Set(), legacy: new Set() };
      let totalUpserted = 0;
      for (const file of files) {
        const artefact = await readArtefact(file); // NOSONAR S9382: one artefact in memory at a time - readFile loads each file whole before the MAX_FILE_BYTES check, and Promise.all would hold up to MAX_FILES of them
        if (artefact === null) {
          continue;
        }
        totalUpserted += ingestArtefact(ctx, artefact, now, ids);
      }

      const itemsDeleted = removeLegacyClampedRows(ctx, ids);
      return { ...syncPassCursorSuccess(t0, 0, pass1Cursor(), totalUpserted), itemsDeleted };
    },
  };
}
