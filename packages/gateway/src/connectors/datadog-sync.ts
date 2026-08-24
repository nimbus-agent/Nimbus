import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  clampSyncTitle,
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "datadog";
const CURSOR_PREFIX = "nimbus-dd1:";

type DdCursorV1 = { pass: number };

function encodeCursor(c: DdCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

function siteHost(site: string): string {
  const s = site.trim() === "" ? "datadoghq.com" : site.trim();
  return `api.${s}`;
}

function datadogMonitorExternalId(idVal: unknown): string {
  if (typeof idVal === "number") {
    return String(idVal);
  }
  if (typeof idVal === "string") {
    return idVal;
  }
  return "";
}

function upsertDatadogMonitorRows(ctx: SyncContext, list: unknown[], now: number): number {
  let upserted = 0;
  for (const item of list) {
    const row = asRecord(item);
    if (row === undefined) {
      continue;
    }
    const idVal = row["id"];
    const nameVal = row["name"];
    const id = datadogMonitorExternalId(idVal);
    if (id === "") {
      continue;
    }
    const name = typeof nameVal === "string" && nameVal !== "" ? nameVal : `monitor ${id}`;
    upsertIndexedItemForSync(ctx, {
      service: SERVICE_ID,
      type: "monitor",
      externalId: id,
      title: clampSyncTitle(name),
      bodyPreview: "",
      url: null,
      canonicalUrl: null,
      modifiedAt: now,
      authorId: null,
      metadata: { monitorId: id },
      pinned: false,
      syncedAt: now,
    });
    upserted += 1;
  }
  return upserted;
}

async function fetchAndUpsertDatadogMonitors(
  ctx: SyncContext,
  apiKey: string,
  appKey: string,
  site: string,
  cursor: string | null,
  t0: number,
): Promise<SyncResult> {
  const u = `https://${siteHost(site)}/api/v1/monitor`;
  const res = await fetch(u, {
    headers: {
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status }, "datadog sync: monitors failed");
    return syncPassCursorHttpEmpty(t0, text.length, cursor, pass1Cursor());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return syncPassCursorParseEmpty(t0, text.length, pass1Cursor());
  }
  const list = Array.isArray(parsed) ? parsed : [];
  const now = Date.now();
  const upserted = upsertDatadogMonitorRows(ctx, list, now);
  return syncPassCursorSuccess(t0, text.length, pass1Cursor(), upserted);
}

export type DatadogSyncableOptions = {
  ensureDatadogMcpRunning: () => Promise<void>;
};

export function createDatadogSyncable(options: DatadogSyncableOptions): Syncable {
  const initialSyncDepthDays = 1;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDatadogMcpRunning();
      const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
      const appKey = (await ctx.getSecret("app_key"))?.trim() ?? "";
      if (apiKey === "" || appKey === "") {
        return syncNoopResult(cursor, t0);
      }
      const siteRaw = await ctx.getSecret("site");
      const site = siteRaw !== null && siteRaw.trim() !== "" ? siteRaw.trim() : "datadoghq.com";

      await ctx.rateLimiter.acquire("datadog");
      return fetchAndUpsertDatadogMonitors(ctx, apiKey, appKey, site, cursor, t0);
    },
  };
}
