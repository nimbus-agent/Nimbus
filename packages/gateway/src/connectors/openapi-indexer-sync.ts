import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import type { ApiEndpointWrite } from "../index/api-endpoint-store.ts";
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

function buildEndpointWrite(args: {
  specPath: string;
  serviceName: string;
  specVersion: string;
  ep: ParsedEndpoint;
  mtimeMs: number;
  syncedAt: number;
}): ApiEndpointWrite {
  const externalId = externalIdFor(args.specPath, args.ep);
  const id = `${SERVICE_ID}:${externalId}`;
  return {
    item: {
      service: SERVICE_ID,
      type: "api_endpoint",
      externalId,
      title: `${args.ep.method} ${args.ep.path}`,
      bodyPreview:
        args.ep.operationId === undefined
          ? args.ep.tags.join(" ").trim()
          : `${args.ep.operationId} ${args.ep.tags.join(" ")}`.trim(),
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
    },
    endpoint: {
      id,
      serviceName: args.serviceName,
      path: args.ep.path,
      method: args.ep.method,
      operationId: args.ep.operationId ?? null,
      tags: args.ep.tags,
      deprecated: args.ep.deprecated,
      specPath: args.specPath,
      specVersion: args.specVersion,
      mtimeMs: args.mtimeMs,
    },
  };
}

function readSpecIfNewer(
  specPath: string,
  tip: number,
): { source: string; mtimeMs: number } | null {
  let mtimeMs = 0;
  let source: string | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(specPath, "r");
    mtimeMs = fstatSync(fd).mtimeMs;
    if (mtimeMs > tip) {
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
  return source === undefined ? null : { source, mtimeMs };
}

function recordSkippedSpec(stats: OpenapiSyncStats, reason: string): void {
  if (reason === "too_large") stats.skippedTooLarge++;
  else if (reason === "parse_failed") stats.skippedParseFailed++;
  else if (reason === "not_a_spec") stats.skippedNotASpec++;
}

type SpecIngestTotals = { upserted: number; deleted: number; nextTip: number };

function ingestSpecPath(
  ctx: SyncContext,
  args: {
    specPath: string;
    root: string;
    config: OpenapiConfig;
    tip: number;
    now: number;
    stats: OpenapiSyncStats;
    totals: SpecIngestTotals;
  },
): void {
  const { specPath, root, config, tip, now, stats, totals } = args;
  const read = readSpecIfNewer(specPath, tip);
  if (read === null) {
    return;
  }
  const parsed = parseSpec({
    absPath: specPath,
    source: read.source,
    maxBytes: config.maxSpecBytes,
  });
  if (parsed.kind === "skipped") {
    recordSkippedSpec(stats, parsed.reason);
    ctx.logger.warn({ specPath, reason: parsed.reason }, "openapi-indexer: skipped spec");
    return;
  }
  const serviceName = inferServiceName({ specPath, infoTitle: parsed.infoTitle, rootPath: root });
  const keep = new Set<string>();
  const writes: ApiEndpointWrite[] = [];
  for (const ep of parsed.endpoints) {
    const write = buildEndpointWrite({
      specPath,
      serviceName,
      specVersion: parsed.specVersion,
      ep,
      mtimeMs: read.mtimeMs,
      syncedAt: now,
    });
    keep.add(write.endpoint.id);
    writes.push(write);
  }
  const { upserted: perSpecUpserted, deleted: perSpecDeleted } = ctx.writeApiEndpointsForSpec({
    specPath,
    endpoints: writes,
    keepIds: keep,
    syncedAt: now,
  });
  totals.upserted += perSpecUpserted;
  totals.deleted += perSpecDeleted;
  if (read.mtimeMs > totals.nextTip) {
    totals.nextTip = read.mtimeMs;
  }
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
      const stats: OpenapiSyncStats = {
        skippedTooLarge: 0,
        skippedParseFailed: 0,
        skippedNotASpec: 0,
      };
      const totals: SpecIngestTotals = { upserted: 0, deleted: 0, nextTip: state.tip };

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
          ingestSpecPath(ctx, {
            specPath,
            root,
            config,
            tip: state.tip,
            now,
            stats,
            totals,
          });
        }
      }

      lastStats = stats;
      return {
        cursor: encodeCursor({ tip: totals.nextTip }),
        itemsUpserted: totals.upserted,
        itemsDeleted: totals.deleted,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
