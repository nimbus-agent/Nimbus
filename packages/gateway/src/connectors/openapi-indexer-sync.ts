import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { dbRun } from "../db/write.ts";
import { deleteItemByPrimaryKey, upsertIndexedItemForSync } from "../index/item-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { syncNoopResult } from "../sync/types.ts";
import { DEFAULT_OPENAPI_CONFIG, type OpenapiConfig } from "./openapi-indexer-config.ts";
import { discoverSpecFiles } from "./openapi-indexer-discovery.ts";
import { type ParsedEndpoint, parseSpec } from "./openapi-indexer-parsing.ts";
import { inferServiceName } from "./openapi-indexer-service-name.ts";

// connectorFetch opt-out: indexes filesystem OpenAPI/AsyncAPI specs, not paginated HTTP.
const SERVICE_ID = "openapi";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_SYNC_DEPTH_DAYS = 365;

export type OpenapiSyncStats = {
  skippedTooLarge: number;
  skippedParseFailed: number;
  skippedNotASpec: number;
};

export type OpenapiIndexerSyncableOptions = {
  roots: readonly NimbusFilesystemRootToml[];
  config?: OpenapiConfig;
};

export type OpenapiIndexerSyncable = Syncable & {
  getLastSyncStats(): OpenapiSyncStats;
};

type CursorState = { tip: number };

function decodeCursor(cursor: string | null): CursorState {
  if (cursor === null) {
    return { tip: 0 };
  }
  try {
    const parsed = JSON.parse(cursor) as { tip?: number };
    return { tip: typeof parsed.tip === "number" ? parsed.tip : 0 };
  } catch {
    return { tip: 0 };
  }
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}

function externalIdFor(specPath: string, ep: ParsedEndpoint): string {
  const sha12 = createHash("sha256").update(specPath).digest("hex").slice(0, 12);
  return `${sha12}#${ep.method}:${ep.path}`;
}

function upsertEndpoint(
  ctx: SyncContext,
  args: {
    specPath: string;
    serviceName: string;
    specVersion: string;
    ep: ParsedEndpoint;
    mtimeMs: number;
    syncedAt: number;
  },
): string {
  const externalId = externalIdFor(args.specPath, args.ep);
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "api_endpoint",
    externalId,
    title: `${args.ep.method} ${args.ep.path}`,
    bodyPreview:
      args.ep.operationId !== undefined
        ? `${args.ep.operationId} ${args.ep.tags.join(" ")}`.trim()
        : args.ep.tags.join(" ").trim(),
    modifiedAt: args.mtimeMs,
    metadata: {
      service_name: args.serviceName,
      spec_file: args.specPath,
      operation_id: args.ep.operationId ?? null,
      tags: args.ep.tags,
      deprecated: args.ep.deprecated,
      spec_version: args.specVersion,
    },
    syncedAt: args.syncedAt,
  });
  const id = `${SERVICE_ID}:${externalId}`;
  dbRun(
    ctx.db,
    `INSERT INTO api_endpoint (
      id, service_name, path, method, operation_id, tags_json, deprecated, spec_file, spec_version, last_modified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      service_name = excluded.service_name,
      path = excluded.path,
      method = excluded.method,
      operation_id = excluded.operation_id,
      tags_json = excluded.tags_json,
      deprecated = excluded.deprecated,
      spec_file = excluded.spec_file,
      spec_version = excluded.spec_version,
      last_modified = excluded.last_modified`,
    [
      id,
      args.serviceName,
      args.ep.path,
      args.ep.method,
      args.ep.operationId ?? null,
      JSON.stringify(args.ep.tags),
      args.ep.deprecated ? 1 : 0,
      args.specPath,
      args.specVersion,
      args.mtimeMs,
      args.syncedAt,
    ],
  );
  return id;
}

function deleteEndpointsAbsentFromSpec(
  db: Database,
  specPath: string,
  keepIds: ReadonlySet<string>,
): number {
  const existing = db
    .query("SELECT id FROM api_endpoint WHERE spec_file = ?")
    .all(specPath) as Array<{ id: string }>;
  let deleted = 0;
  for (const row of existing) {
    if (keepIds.has(row.id)) {
      continue;
    }
    deleteItemByPrimaryKey(db, row.id);
    dbRun(db, "DELETE FROM api_endpoint WHERE id = ?", [row.id]);
    deleted++;
  }
  return deleted;
}

export function createOpenapiIndexerSyncable(
  options: OpenapiIndexerSyncableOptions,
): OpenapiIndexerSyncable {
  const config = options.config ?? DEFAULT_OPENAPI_CONFIG;
  let lastStats: OpenapiSyncStats = {
    skippedTooLarge: 0,
    skippedParseFailed: 0,
    skippedNotASpec: 0,
  };
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
    initialSyncDepthDays: INITIAL_SYNC_DEPTH_DAYS,
    getLastSyncStats(): OpenapiSyncStats {
      return lastStats;
    },
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      if (options.roots.length === 0) {
        return syncNoopResult(cursor, t0);
      }
      await ctx.rateLimiter.acquire("filesystem");
      const state = decodeCursor(cursor);
      const now = Date.now();
      let upserted = 0;
      let deleted = 0;
      let nextTip = state.tip;
      const stats: OpenapiSyncStats = {
        skippedTooLarge: 0,
        skippedParseFailed: 0,
        skippedNotASpec: 0,
      };

      for (const rootCfg of options.roots) {
        const root = rootCfg.path;
        let entries: readonly string[];
        try {
          entries = discoverSpecFiles(root, {
            maxWalkDepth: config.maxWalkDepth,
            ignoreGlobs: config.ignoreGlobs,
          });
        } catch {
          continue;
        }
        for (const specPath of entries) {
          let mtimeMs = 0;
          let source: string | undefined;
          let fd: number | undefined;
          try {
            fd = openSync(specPath, "r");
            mtimeMs = fstatSync(fd).mtimeMs;
            if (mtimeMs > state.tip) {
              source = readFileSync(fd, "utf8");
            }
          } catch {
            // file disappeared / unreadable — skip to next entry
          } finally {
            if (fd !== undefined) {
              try {
                closeSync(fd);
              } catch {
                // ignore close errors
              }
            }
          }
          if (source === undefined) {
            continue;
          }
          const parsed = parseSpec({
            absPath: specPath,
            source,
            maxBytes: config.maxSpecBytes,
          });
          if (parsed.kind === "skipped") {
            if (parsed.reason === "too_large") stats.skippedTooLarge++;
            else if (parsed.reason === "parse_failed") stats.skippedParseFailed++;
            else if (parsed.reason === "not_a_spec") stats.skippedNotASpec++;
            ctx.logger.warn({ specPath, reason: parsed.reason }, "openapi-indexer: skipped spec");
            continue;
          }
          const serviceName = inferServiceName({
            specPath,
            infoTitle: parsed.infoTitle,
            rootPath: root,
          });
          const keep = new Set<string>();
          let perSpecDeleted = 0;
          ctx.db.transaction(() => {
            for (const ep of parsed.endpoints) {
              const id = upsertEndpoint(ctx, {
                specPath,
                serviceName,
                specVersion: parsed.specVersion,
                ep,
                mtimeMs,
                syncedAt: now,
              });
              keep.add(id);
              upserted++;
            }
            perSpecDeleted = deleteEndpointsAbsentFromSpec(ctx.db, specPath, keep);
          })();
          deleted += perSpecDeleted;
          if (mtimeMs > nextTip) {
            nextTip = mtimeMs;
          }
        }
      }

      lastStats = stats;
      return {
        cursor: encodeCursor({ tip: nextTip }),
        itemsUpserted: upserted,
        itemsDeleted: deleted,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
