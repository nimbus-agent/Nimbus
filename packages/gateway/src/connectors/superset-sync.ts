import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSupersetDashboardToItem } from "./superset-dashboard-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "superset";
const CURSOR_PREFIX = "nimbus-superset1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type SupersetCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies SupersetCursorV1);
}

export type SupersetSyncableOptions = {
  ensureSupersetMcpRunning: () => Promise<void>;
};

interface SupersetCreds {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<SupersetCreds | null> {
  const url = (await ctx.getSecret("url"))?.trim() ?? "";
  const username = (await ctx.getSecret("username"))?.trim() ?? "";
  const password = (await ctx.getSecret("password"))?.trim() ?? "";
  if (url === "" || username === "" || password === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), username, password };
}

async function supersetLogin(
  ctx: SyncContext,
  creds: SupersetCreds,
): Promise<{ token: string | null; bytes: number }> {
  const outcome = await connectorFetch(ctx, SERVICE_ID, `${creds.url}/api/v1/security/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      username: creds.username,
      password: creds.password,
      provider: "db",
      refresh: true,
    }),
  });
  if (outcome.kind === "http_error") {
    return { token: null, bytes: outcome.bytes };
  }
  if (outcome.kind === "parse_error") {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "superset login returned invalid JSON");
    return { token: null, bytes: outcome.bytes };
  }
  const parsed = outcome.parsed as { access_token?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "superset login returned no access_token");
    return { token: null, bytes: outcome.bytes };
  }
  return { token: parsed.access_token, bytes: outcome.bytes };
}

function supersetGet(ctx: SyncContext, creds: SupersetCreds, token: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.url}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractResult(parsed: unknown): unknown[] {
  const result = asRecord(parsed)?.["result"];
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(parsed) ? parsed : [];
}

function dashboardListPath(page: number): string {
  const q = encodeURIComponent(`(page:${String(page)},page_size:${String(PAGE_SIZE)})`);
  return `/api/v1/dashboard/?q=${q}`;
}

function upsertDashboards(
  ctx: SyncContext,
  creds: SupersetCreds,
  dashboards: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const d of dashboards) {
    const mapped = mapSupersetDashboardToItem(d, { baseUrl: creds.url, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createSupersetSyncable(options: SupersetSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSupersetMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const auth = await supersetLogin(ctx, creds);
      let totalBytes = auth.bytes;
      if (auth.token === null) {
        return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await supersetGet(ctx, creds, auth.token, dashboardListPath(page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }
        const dashboards = extractResult(outcome.parsed);
        totalUpserted += upsertDashboards(ctx, creds, dashboards, now);
        if (dashboards.length < PAGE_SIZE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
