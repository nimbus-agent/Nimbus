/**
 * Apache Superset dashboards sync handler. Superset has no static API key:
 * each cycle authenticates with username/password against
 * `POST /api/v1/security/login` to obtain a short-lived JWT, then walks
 * `GET /api/v1/dashboard/?q=(page:N,page_size:100)` with
 * `Authorization: Bearer <access_token>` and upserts each dashboard into the
 * unified `item` table as `service = "superset", type = "dashboard"` via
 * {@link mapSupersetDashboardToItem}.
 *
 * Auth posture: login failure (non-ok or no access_token) degrades the whole
 * sync to a graceful empty pass — we log a warning and return the pass-cursor
 * http-empty result, never throw. The password is never put in any logger
 * call.
 *
 * Single-pass cursor model (matches dbt/metabase/wiz): every successful run
 * emits a fresh `nimbus-superset1:{pass: 1}` cursor. The dashboards list is
 * Rison-paginated within a single cycle; we cap pages per cycle to bound cost.
 * The FIRST dashboards page is the gating call — its http/parse error maps to
 * the pass-cursor-empty result; a later-page non-ok just breaks the loop.
 *
 * All three vault keys (`superset.url` + `superset.username` +
 * `superset.password`) are required and have no defaults — Superset is
 * self-hosted with no universal SaaS host. The connector no-ops unless all
 * three are non-empty after trim.
 */

import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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
  const url = (await readConnectorSecret(ctx.vault, "superset", "url"))?.trim() ?? "";
  const username = (await readConnectorSecret(ctx.vault, "superset", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(ctx.vault, "superset", "password"))?.trim() ?? "";
  if (url === "" || username === "" || password === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), username, password };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/**
 * Exchange username/password for a JWT access token. NEVER logs the password.
 * Returns the token plus the bytes transferred, or a null token on any failure
 * (caller maps that to the graceful empty pass).
 */
async function supersetLogin(
  ctx: SyncContext,
  creds: SupersetCreds,
): Promise<{ token: string | null; bytes: number }> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${creds.url}/api/v1/security/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      username: creds.username,
      password: creds.password,
      provider: "db",
      refresh: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status }, "superset login failed");
    return { token: null, bytes: text.length };
  }
  try {
    const parsed = JSON.parse(text) as { access_token?: unknown };
    if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
      ctx.logger.warn({ serviceId: SERVICE_ID }, "superset login returned no access_token");
      return { token: null, bytes: text.length };
    }
    return { token: parsed.access_token, bytes: text.length };
  } catch {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "superset login returned invalid JSON");
    return { token: null, bytes: text.length };
  }
}

async function supersetGet(
  ctx: SyncContext,
  creds: SupersetCreds,
  token: string,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${creds.url}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "superset GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/** Coerce a Superset list response into an array (`.result`, else a bare array). */
function extractResult(parsed: unknown): unknown[] {
  const result = asRecord(parsed)?.["result"];
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** Build the Rison `q` page query string for `/api/v1/dashboard/`. */
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

      // Authenticate first. A login failure degrades the whole sync to a
      // graceful empty pass (no dashboard GET is attempted).
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
          // The FIRST page is the gating call: its http/parse error maps to
          // the pass-cursor-empty result. A later-page error just breaks.
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
