import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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
  const baseUrl = (await readConnectorSecret(ctx.vault, "elasticsearch", "url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(ctx.vault, "elasticsearch", "api_key"))?.trim() ?? "";
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

async function walkIndices(
  ctx: SyncContext,
  creds: ElasticsearchCreds,
  rows: readonly unknown[],
  now: number,
): Promise<WalkResult> {
  let upserted = 0;
  let bytes = 0;

  // 1. Filter and cap the valid indices
  const validRows: { row: unknown; name: string }[] = [];
  for (const row of rows) {
    if (validRows.length >= MAX_INDICES) {
      break;
    }
    const name = indexNameOf(row);
    if (name !== null && !isSystemIndex(name)) {
      validRows.push({ row, name });
    }
  }

  // 2. Fetch details in batches of 50 for the first MAX_INDEX_DETAIL indices
  const mappingResults: Record<string, { fields: Array<{ name: string; type: string }> }> = {};
  const indicesWithDetails = validRows.slice(0, MAX_INDEX_DETAIL);
  const BATCH_SIZE = 50;

  for (let i = 0; i < indicesWithDetails.length; i += BATCH_SIZE) {
    const batch = indicesWithDetails.slice(i, i + BATCH_SIZE);
    const names = batch.map((b) => encodeURIComponent(b.name)).join(",");
    const detail = await esGet(ctx, creds, `/${names}/_mapping`);
    bytes += detail.bytes;

    if (detail.kind === "ok") {
      for (const { name } of batch) {
        mappingResults[name] = { fields: flattenMappingFields(detail.parsed, name) };
      }
    }
  }

  // 3. Process and upsert items
  for (let i = 0; i < validRows.length; i++) {
    const rowEntry = validRows[i];
    if (!rowEntry) continue;
    const { row, name } = rowEntry;
    const fields = mappingResults[name]?.fields ?? [];

    const mapped = mapElasticsearchIndexToItem(row, { fields, syncedAt: now });
    if (mapped !== null) {
      upsertIndexedItemForSync(ctx, mapped);
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
