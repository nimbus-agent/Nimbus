import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapMlflowModelToItem } from "./mlflow-model-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "mlflow";
const CURSOR_PREFIX = "nimbus-mlflow1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type MlflowCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MlflowCursorV1);
}

export type MlflowSyncableOptions = {
  ensureMlflowMcpRunning: () => Promise<void>;
};

interface MlflowCreds {
  readonly host: string;
  readonly token: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<MlflowCreds | null> {
  const host = (await ctx.getSecret("host"))?.trim() ?? "";
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (host === "" || token === "") {
    return null;
  }
  return { host: trimTrailingSlash(host), token };
}

function mlflowGet(ctx: SyncContext, creds: MlflowCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.host}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

function searchPath(pageToken: string | null): string {
  const params = new URLSearchParams({ max_results: String(PAGE_SIZE) });
  if (pageToken !== null) {
    params.set("page_token", pageToken);
  }
  return `/api/2.0/mlflow/registered-models/search?${params.toString()}`;
}

function parseMlflowPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const envelope = asRecord(parsed) ?? {};
  const rawModels = envelope["registered_models"];
  const items = Array.isArray(rawModels) ? rawModels : [];
  const nextToken = stringField(envelope, "next_page_token") ?? "";
  return { items, hasMore: nextToken !== "", nextPageCursor: nextToken };
}

export function createMlflowSyncable(options: MlflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureMlflowMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) =>
          mlflowGet(ctx, creds, searchPath(pageCursor === "" ? null : pageCursor)),
        parsePage: (parsed) => parseMlflowPage(parsed),
        map: (raw, creds, now) => mapMlflowModelToItem(raw, { host: creds.host, syncedAt: now }),
      }),
  };
}
