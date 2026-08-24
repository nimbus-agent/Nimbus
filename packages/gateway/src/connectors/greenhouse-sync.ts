import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { bareArrayPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapGreenhouseJobToItem } from "./greenhouse-job-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "greenhouse";
const CURSOR_PREFIX = "nimbus-greenhouse1:";
const BASE = "https://harvest.greenhouse.io";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type GreenhouseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies GreenhouseCursorV1);
}

export type GreenhouseSyncableOptions = {
  ensureGreenhouseMcpRunning: () => Promise<void>;
};

interface GreenhouseCreds {
  readonly apiKey: string;
}

async function loadCreds(ctx: SyncContext): Promise<GreenhouseCreds | null> {
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function jobsPath(page: number): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
  return `/v1/jobs?${params.toString()}`;
}

function greenhouseGet(ctx: SyncContext, creds: GreenhouseCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: basicAuthHeader(creds.apiKey), Accept: "application/json" },
  });
}

export function createGreenhouseSyncable(options: GreenhouseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureGreenhouseMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => greenhouseGet(ctx, creds, jobsPath(page)),
        parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE),
        map: (raw, _creds, now) => mapGreenhouseJobToItem(raw, { syncedAt: now }),
      }),
  };
}
