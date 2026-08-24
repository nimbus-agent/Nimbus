import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapAirflowDagToItem } from "./airflow-dag-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "airflow";
const CURSOR_PREFIX = "nimbus-airflow1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type AirflowCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies AirflowCursorV1);
}

export type AirflowSyncableOptions = {
  ensureAirflowMcpRunning: () => Promise<void>;
};

interface AirflowCreds {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<AirflowCreds | null> {
  const baseUrl = (await ctx.getSecret("base_url"))?.trim() ?? "";
  const username = (await ctx.getSecret("username"))?.trim() ?? "";
  const password = (await ctx.getSecret("password"))?.trim() ?? "";
  if (baseUrl === "" || username === "" || password === "") {
    return null;
  }
  return { baseUrl: trimTrailingSlash(baseUrl), username, password };
}

// The gateway cannot import the mcp-shared encodeBasicAuthHeader (cross-package
// boundary), so build the HTTP Basic header inline — same pattern as
// bitbucket-sync / jenkins-sync.
function basicAuthHeader(user: string, pass: string): string {
  const b64 = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function dagsPath(offset: number): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `/api/v1/dags?${params.toString()}`;
}

function airflowGet(ctx: SyncContext, creds: AirflowCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}${path}`, {
    headers: {
      Authorization: basicAuthHeader(creds.username, creds.password),
      Accept: "application/json",
    },
  });
}

function parseAirflowPage(parsed: unknown, page: number): { items: unknown[]; hasMore: boolean } {
  const dagsRaw = (parsed as { dags?: unknown } | null)?.dags;
  const dags = Array.isArray(dagsRaw) ? dagsRaw : [];
  const totalRaw = (parsed as { total_entries?: unknown } | null)?.total_entries;
  const total = typeof totalRaw === "number" && Number.isFinite(totalRaw) ? totalRaw : 0;
  const offset = page * PAGE_SIZE;
  return { items: dags, hasMore: dags.length >= PAGE_SIZE && offset + dags.length < total };
}

export function createAirflowSyncable(options: AirflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureAirflowMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, page) => airflowGet(ctx, creds, dagsPath(page * PAGE_SIZE)),
        parsePage: (parsed, page) => parseAirflowPage(parsed, page),
        map: (raw, creds, now) =>
          mapAirflowDagToItem(raw, { baseUrl: creds.baseUrl, syncedAt: now }),
      }),
  };
}
