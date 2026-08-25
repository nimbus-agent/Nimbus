import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import {
  flattenMappingFields,
  mapElasticsearchIndexToItem,
} from "./elasticsearch-index-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "elasticsearch";
const CURSOR_PREFIX = "nimbus-es1:";

// Caps — single forward pass per cycle.
const MAX_INDICES = 500;
// Per-index `_mapping` (for field names/types) is bounded to avoid unbounded
// fan-out. Indices beyond this cap are emitted with empty `fields`.
const MAX_INDEX_DETAIL = 200;

type ElasticsearchCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ElasticsearchCursorV1);
}

export type ElasticsearchSyncableOptions = {
  ensureElasticsearchMcpRunning: () => Promise<void>;
};

interface ElasticsearchCreds {
  readonly baseUrl: string;
  readonly apiKey: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<ElasticsearchCreds | null> {
  const baseUrl = (await ctx.getSecret("url"))?.trim() ?? "";
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  if (baseUrl === "" || apiKey === "") {
    return null;
  }
  return { baseUrl: trimTrailingSlash(baseUrl), apiKey };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" };
}

function esGet(ctx: SyncContext, creds: ElasticsearchCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}${path}`, {
    headers: authHeaders(creds.apiKey),
  });
}

/** `_cat/indices?format=json` returns a JSON array of per-index metadata rows. */
function catRows(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function indexNameOf(row: unknown): string | null {
  const rec = asRecord(row);
  if (rec === undefined) {
    return null;
  }
  const name = stringField(rec, "index");
  return name !== undefined && name !== "" ? name : null;
}

/** Skip Elasticsearch system / hidden indices (names starting with `.`). */
function isSystemIndex(name: string): boolean {
  return name.startsWith(".");
}

interface WalkResult {
  readonly upserted: number;
  readonly bytes: number;
}

type IndexRow = { row: unknown; name: string };
type MappingsByIndex = Record<string, { fields: Array<{ name: string; type: string }> }>;

/**
 * Step 1 — the indices worth indexing, capped at `MAX_INDICES`.
 *
 * The cap is applied while filtering rather than after it, so a cluster whose
 * first thousand indices are all system indices still yields `MAX_INDICES` real
 * ones instead of an empty result.
 */
function selectIndexableRows(rows: readonly unknown[]): IndexRow[] {
  const out: IndexRow[] = [];
  for (const row of rows) {
    if (out.length >= MAX_INDICES) {
      break;
    }
    const name = indexNameOf(row);
    if (name !== null && !isSystemIndex(name)) {
      out.push({ row, name });
    }
  }
  return out;
}

/**
 * Step 2 — field mappings for the first `MAX_INDEX_DETAIL` indices, fetched in
 * batches of 50 so one request covers many indices.
 *
 * A failed batch is SKIPPED, not fatal: `detail.kind !== "ok"` simply leaves
 * those names absent from the result, and step 3 falls back to `[]` fields for
 * them. An index still gets indexed without its field list — losing the whole
 * sync because one mapping request failed would be the worse trade. `bytes` is
 * accumulated whether or not the batch parsed, since the transfer happened
 * either way and the caller meters real traffic.
 */
async function fetchIndexMappings(
  ctx: SyncContext,
  creds: ElasticsearchCreds,
  validRows: readonly IndexRow[],
): Promise<{ mappings: MappingsByIndex; bytes: number }> {
  const mappings: MappingsByIndex = {};
  let bytes = 0;
  const withDetails = validRows.slice(0, MAX_INDEX_DETAIL);
  const BATCH_SIZE = 50;

  for (let i = 0; i < withDetails.length; i += BATCH_SIZE) {
    const batch = withDetails.slice(i, i + BATCH_SIZE);
    const names = batch.map((b) => encodeURIComponent(b.name)).join(",");
    const detail = await esGet(ctx, creds, `/${names}/_mapping`);
    bytes += detail.bytes;

    if (detail.kind === "ok") {
      for (const { name } of batch) {
        mappings[name] = { fields: flattenMappingFields(detail.parsed, name) };
      }
    }
  }
  return { mappings, bytes };
}

async function walkIndices(
  ctx: SyncContext,
  creds: ElasticsearchCreds,
  rows: readonly unknown[],
  now: number,
): Promise<WalkResult> {
  let upserted = 0;

  const validRows = selectIndexableRows(rows);
  const { mappings: mappingResults, bytes } = await fetchIndexMappings(ctx, creds, validRows);

  // 3. Process and upsert items
  for (const item of validRows) {
    const { row, name } = item;
    const fields = mappingResults[name]?.fields ?? [];

    const mapped = mapElasticsearchIndexToItem(row, { fields, syncedAt: now });
    if (mapped !== null) {
      ctx.upsertItem(mapped);
      upserted += 1;
    }
  }

  return { upserted, bytes };
}

export function createElasticsearchSyncable(options: ElasticsearchSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureElasticsearchMcpRunning();

      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      // `_cat/indices` returns the full index list in one response (bytes=b →
      // store.size in raw bytes for a stable numeric metadata column).
      const listing = await esGet(ctx, creds, "/_cat/indices?format=json&bytes=b");
      let totalBytes = listing.bytes;
      if (listing.kind !== "ok") {
        return listing.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const walk = await walkIndices(ctx, creds, catRows(listing.parsed), now);
      totalBytes += walk.bytes;

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), walk.upserted);
    },
  };
}
