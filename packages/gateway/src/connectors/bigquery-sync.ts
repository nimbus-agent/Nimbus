import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapBigqueryTableToItem } from "./bigquery-table-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "bigquery";
const CURSOR_PREFIX = "nimbus-bq1:";
const BASE = "https://bigquery.googleapis.com/bigquery/v2";

// Page caps — single forward pass per cycle.
const MAX_DATASETS = 100;
const MAX_TABLES_PER_DATASET = 500;
const PAGE_SIZE = 100;
// Per-table detail (for schema.fields) is bounded to avoid unbounded fan-out.
// Tables beyond this cap per dataset are emitted from the list-response metadata.
const MAX_TABLE_DETAIL = 50;

type BigqueryCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies BigqueryCursorV1);
}

/**
 * Mints a short-lived GCP access token by shelling `gcloud auth print-access-token`
 * with `GOOGLE_APPLICATION_CREDENTIALS` pointed at the configured service-account
 * key (gcloud respects this for Application Default Credentials). Returns null when
 * gcloud is missing or exits non-zero — the caller degrades gracefully (no throw
 * past the Syncable boundary), mirroring gcp-sync's `!res.ok` posture.
 */
async function gcloudPrintAccessToken(credPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gcloud", "auth", "print-access-token"], {
      env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      return null;
    }
    const out = (await new Response(proc.stdout).text()).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Injectable token-mint — defaults to the gcloud spawn; tests pass a stub. */
export type MintAccessToken = (credPath: string) => Promise<string | null>;

export type BigquerySyncableOptions = {
  ensureBigqueryMcpRunning: () => Promise<void>;
  /** Override the gcloud token-mint (dependency injection for tests). */
  mintAccessToken?: MintAccessToken;
};

interface BigqueryCreds {
  readonly credPath: string;
  readonly project: string;
}

async function loadCreds(ctx: SyncContext): Promise<BigqueryCreds | null> {
  const credPath = (await ctx.getSharedSecret("gcp", "credentials_json_path"))?.trim() ?? "";
  const project = (await ctx.getSharedSecret("gcp", "project_id"))?.trim() ?? "";
  if (credPath === "" || project === "") {
    return null;
  }
  return { credPath, project };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function bqGet(ctx: SyncContext, token: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, { headers: authHeaders(token) });
}

function datasetsPath(project: string, pageToken: string | null): string {
  const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
  if (pageToken !== null && pageToken !== "") {
    params.set("pageToken", pageToken);
  }
  return `/projects/${encodeURIComponent(project)}/datasets?${params.toString()}`;
}

function tablesPath(project: string, datasetId: string, pageToken: string | null): string {
  const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
  if (pageToken !== null && pageToken !== "") {
    params.set("pageToken", pageToken);
  }
  return `/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}/tables?${params.toString()}`;
}

function tableDetailPath(project: string, datasetId: string, tableId: string): string {
  return `/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`;
}

function nextPageToken(parsed: unknown): string | null {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return null;
  }
  const tok = stringField(rec, "nextPageToken");
  return tok !== undefined && tok !== "" ? tok : null;
}

function extractArray(parsed: unknown, key: string): unknown[] {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return [];
  }
  const arr = rec[key];
  return Array.isArray(arr) ? arr : [];
}

function datasetIdOf(entry: unknown): string | null {
  const rec = asRecord(entry);
  if (rec === undefined) {
    return null;
  }
  const ref = asRecord(rec["datasetReference"]);
  if (ref === undefined) {
    return null;
  }
  const id = stringField(ref, "datasetId");
  return id !== undefined && id !== "" ? id : null;
}

function tableIdOf(entry: unknown): string | null {
  const rec = asRecord(entry);
  if (rec === undefined) {
    return null;
  }
  const ref = asRecord(rec["tableReference"]);
  if (ref === undefined) {
    return null;
  }
  const id = stringField(ref, "tableId");
  return id !== undefined && id !== "" ? id : null;
}

interface DatasetIdsResult {
  readonly ids: string[];
  readonly bytes: number;
  readonly firstOutcomeFailed: "http" | "parse" | null;
}

/** Append dataset ids on a single `datasets` page into `ids`, capped at `MAX_DATASETS`. */
function collectDatasetPage(parsed: unknown, ids: string[]): void {
  for (const entry of extractArray(parsed, "datasets")) {
    if (ids.length >= MAX_DATASETS) {
      return;
    }
    const id = datasetIdOf(entry);
    if (id !== null) {
      ids.push(id);
    }
  }
}

async function collectDatasetIds(
  ctx: SyncContext,
  token: string,
  project: string,
): Promise<DatasetIdsResult> {
  const ids: string[] = [];
  let bytes = 0;
  let pageToken: string | null = null;
  let page = 0;
  while (ids.length < MAX_DATASETS) {
    const outcome = await bqGet(ctx, token, datasetsPath(project, pageToken));
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      if (page === 0) {
        return { ids, bytes, firstOutcomeFailed: outcome.kind === "http_error" ? "http" : "parse" };
      }
      break;
    }
    collectDatasetPage(outcome.parsed, ids);
    pageToken = nextPageToken(outcome.parsed);
    page += 1;
    if (pageToken === null) {
      break;
    }
  }
  return { ids, bytes, firstOutcomeFailed: null };
}

interface DatasetWalkResult {
  readonly upserted: number;
  readonly bytes: number;
}

interface DatasetWalkState {
  upserted: number;
  bytes: number;
  seen: number;
  detailsFetched: number;
}

/**
 * Resolve the table source row — optionally enriched with full schema fields via
 * a per-table `describe`, page-capped by `MAX_TABLE_DETAIL`. Mutates the byte +
 * detail counters on `state`.
 */
async function resolveTableSource(
  ctx: SyncContext,
  token: string,
  project: string,
  datasetId: string,
  entry: unknown,
  state: DatasetWalkState,
): Promise<unknown> {
  const tableId = tableIdOf(entry);
  if (tableId === null || state.detailsFetched >= MAX_TABLE_DETAIL) {
    return entry;
  }
  state.detailsFetched += 1;
  const detail = await bqGet(ctx, token, tableDetailPath(project, datasetId, tableId));
  state.bytes += detail.bytes;
  return detail.kind === "ok" ? detail.parsed : entry;
}

/** Upsert one `tables` page, threading the running counters through `state`. */
async function upsertTablesPage(
  ctx: SyncContext,
  token: string,
  project: string,
  datasetId: string,
  now: number,
  parsed: unknown,
  state: DatasetWalkState,
): Promise<void> {
  for (const entry of extractArray(parsed, "tables")) {
    if (state.seen >= MAX_TABLES_PER_DATASET) {
      break;
    }
    state.seen += 1;
    const source = await resolveTableSource(ctx, token, project, datasetId, entry, state);
    const mapped = mapBigqueryTableToItem(source, { project, syncedAt: now });
    if (mapped !== null) {
      ctx.upsertItem(mapped);
      state.upserted += 1;
    }
  }
}

async function walkDataset(
  ctx: SyncContext,
  token: string,
  project: string,
  datasetId: string,
  now: number,
): Promise<DatasetWalkResult> {
  const state: DatasetWalkState = { upserted: 0, bytes: 0, seen: 0, detailsFetched: 0 };
  let pageToken: string | null = null;

  while (state.seen < MAX_TABLES_PER_DATASET) {
    const outcome = await bqGet(ctx, token, tablesPath(project, datasetId, pageToken));
    state.bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      break;
    }
    await upsertTablesPage(ctx, token, project, datasetId, now, outcome.parsed, state);
    pageToken = nextPageToken(outcome.parsed);
    if (pageToken === null) {
      break;
    }
  }
  return { upserted: state.upserted, bytes: state.bytes };
}

export function createBigquerySyncable(options: BigquerySyncableOptions): Syncable {
  const mint = options.mintAccessToken ?? gcloudPrintAccessToken;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureBigqueryMcpRunning();

      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire(SERVICE_ID);
      const token = await mint(creds.credPath);
      if (token === null) {
        ctx.logger.warn({ serviceId: SERVICE_ID }, "bigquery sync: gcloud token mint failed");
        // Preserve cursor; graceful empty pass (no throw past the Syncable boundary).
        return syncPassCursorHttpEmpty(t0, 0, cursor, pass1Cursor());
      }

      const now = Date.now();
      const datasets = await collectDatasetIds(ctx, token, creds.project);
      let totalBytes = datasets.bytes;
      if (datasets.firstOutcomeFailed !== null) {
        return datasets.firstOutcomeFailed === "http"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      let totalUpserted = 0;
      for (const datasetId of datasets.ids) {
        const res = await walkDataset(ctx, token, creds.project, datasetId, now);
        totalUpserted += res.upserted;
        totalBytes += res.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
