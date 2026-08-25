import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import {
  type GreatExpectationsMappingContext,
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

async function collectJsonFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
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

function ingestArtefact(ctx: SyncContext, artefact: ParsedArtefact, syncedAt: number): number {
  const results = artefact.parsed["results"];
  if (!Array.isArray(results)) {
    return 0;
  }
  const mappingCtx = buildMappingContext(artefact.parsed, syncedAt, artefact.mtimeMs);
  let upserted = 0;
  for (const entry of results) {
    const mapped = mapGreatExpectationsResultToItem(entry, mappingCtx);
    if (mapped !== null) {
      ctx.upsertItem(mapped);
      upserted += 1;
    }
  }
  return upserted;
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
      let totalUpserted = 0;
      for (const file of files) {
        const artefact = await readArtefact(file);
        if (artefact === null) {
          continue;
        }
        totalUpserted += ingestArtefact(ctx, artefact, now);
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), totalUpserted);
    },
  };
}
