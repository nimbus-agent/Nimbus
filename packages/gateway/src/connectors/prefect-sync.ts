import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { bareArrayPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapPrefectDeploymentToItem } from "./prefect-deployment-mapping.ts";

const SERVICE_ID = "prefect";
const CURSOR_PREFIX = "nimbus-prefect1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type PrefectCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies PrefectCursorV1);
}

export type PrefectSyncableOptions = {
  ensurePrefectMcpRunning: () => Promise<void>;
};

interface PrefectCreds {
  readonly apiUrl: string;
  readonly apiKey: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<PrefectCreds | null> {
  const apiUrl = (await ctx.getSecret("api_url"))?.trim() ?? "";
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  // Both keys are required for spawn/sync to keep wiring uniform — a keyless
  // self-hosted Prefect Server still gets a placeholder api_key.
  if (apiUrl === "" || apiKey === "") {
    return null;
  }
  return { apiUrl: trimTrailingSlash(apiUrl), apiKey };
}

/**
 * Prefect's list endpoints are POST-with-body filters, not GET query-string
 * endpoints. POST `<api_url>/deployments/filter` with `{ limit, offset, sort }`
 * returns a bare JSON array of deployment objects.
 */
function deploymentsFilter(ctx: SyncContext, creds: PrefectCreds, offset: number) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.apiUrl}/deployments/filter`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ limit: PAGE_SIZE, offset, sort: "CREATED_DESC" }),
  });
}

export function createPrefectSyncable(options: PrefectSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    // The POST /deployments/filter endpoint returns a bare array with no
    // total count; walk a single forward offset pass per cycle, stopping on
    // a short/empty page or the page cap.
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensurePrefectMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, page) => deploymentsFilter(ctx, creds, page * PAGE_SIZE),
        parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE),
        map: (raw, creds, now) =>
          mapPrefectDeploymentToItem(raw, { apiUrl: creds.apiUrl, syncedAt: now }),
      }),
  };
}
