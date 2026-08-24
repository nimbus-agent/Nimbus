import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { bareArrayPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapDependencyTrackProjectToItem } from "./dependencytrack-project-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "dependencytrack";
const CURSOR_PREFIX = "nimbus-dependencytrack1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type DependencyTrackCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies DependencyTrackCursorV1);
}

export type DependencyTrackSyncableOptions = {
  ensureDependencytrackMcpRunning: () => Promise<void>;
};

interface DependencyTrackCreds {
  readonly baseUrl: string;
  readonly apiKey: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<DependencyTrackCreds | null> {
  const baseUrl = (await ctx.getSecret("base_url"))?.trim() ?? "";
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  if (baseUrl === "" || apiKey === "") {
    return null;
  }
  return { baseUrl: trimTrailingSlash(baseUrl), apiKey };
}

function projectsPath(pageNumber: number): string {
  const params = new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    pageNumber: String(pageNumber),
    excludeInactive: "false",
  });
  return `/api/v1/project?${params.toString()}`;
}

function dtGet(ctx: SyncContext, creds: DependencyTrackCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}${path}`, {
    headers: { "X-Api-Key": creds.apiKey, Accept: "application/json" },
  });
}

export function createDependencytrackSyncable(options: DependencyTrackSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureDependencytrackMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => dtGet(ctx, creds, projectsPath(page)),
        parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE),
        map: (raw, creds, now) =>
          mapDependencyTrackProjectToItem(raw, { baseUrl: creds.baseUrl, syncedAt: now }),
      }),
  };
}
