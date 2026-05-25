import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapMetabaseDashboardToItem } from "./metabase-dashboard-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "metabase";
const CURSOR_PREFIX = "nimbus-metabase1:";

type MetabaseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MetabaseCursorV1);
}

export type MetabaseSyncableOptions = {
  ensureMetabaseMcpRunning: () => Promise<void>;
};

interface MetabaseCreds {
  readonly url: string;
  readonly apiKey: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Both `metabase.url` and `metabase.api_key` are required and have no
 * defaults — Metabase has no universal SaaS host to fall back to. The
 * connector no-ops unless both are non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<MetabaseCreds | null> {
  const url = (await readConnectorSecret(ctx.vault, "metabase", "url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(ctx.vault, "metabase", "api_key"))?.trim() ?? "";
  if (url === "" || apiKey === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), apiKey };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function mbGet(ctx: SyncContext, creds: MetabaseCreds, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Metabase API key is sent as the `x-api-key` header (NOT `Authorization`).
  // Paths already include `/api/...`, so the base is the host root.
  const res = await fetch(`${creds.url}${path}`, {
    headers: { "x-api-key": creds.apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "metabase GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/** Coerce a Metabase list response into an array (bare array, else `.data`). */
function extractArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  const data = asRecord(parsed)?.["data"];
  return Array.isArray(data) ? data : [];
}

/**
 * Build a `String(collection_id)` → name map from `/api/collection`. Metabase
 * collection ids can be numbers OR the string `"root"`; both key the map by
 * their string form.
 */
function extractCollectionNames(parsed: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of extractArray(parsed)) {
    const row = asRecord(c);
    if (row === undefined) {
      continue;
    }
    const idNum = numberField(row, "id");
    const idStr = stringField(row, "id");
    const key = idNum !== undefined ? String(idNum) : (idStr ?? "");
    const name = stringField(row, "name");
    if (key !== "" && name !== undefined && name !== "") {
      map[key] = name;
    }
  }
  return map;
}

function upsertDashboards(
  ctx: SyncContext,
  creds: MetabaseCreds,
  collectionNames: Record<string, string>,
  dashboards: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const d of dashboards) {
    const mapped = mapMetabaseDashboardToItem(d, {
      baseUrl: creds.url,
      collectionNames,
      syncedAt: now,
    });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createMetabaseSyncable(options: MetabaseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMetabaseMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      // One cheap collection call to resolve collection ids → names. A non-ok
      // response here is non-fatal — proceed with an empty map (dashboards
      // still index, with `collection_name` null).
      const collectionsOutcome = await mbGet(ctx, creds, "/api/collection");
      let totalBytes = collectionsOutcome.bytes;
      const collectionNames =
        collectionsOutcome.kind === "ok" ? extractCollectionNames(collectionsOutcome.parsed) : {};

      // Metabase returns the full dashboard list in one response — no
      // pagination. This is the gating call: its http/parse error maps to the
      // pass-cursor-empty result.
      const outcome = await mbGet(ctx, creds, "/api/dashboard");
      totalBytes += outcome.bytes;
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      const upserted = upsertDashboards(
        ctx,
        creds,
        collectionNames,
        extractArray(outcome.parsed),
        now,
      );

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}
