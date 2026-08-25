import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
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

async function loadCreds(ctx: SyncContext): Promise<MetabaseCreds | null> {
  const url = (await ctx.getSecret("url"))?.trim() ?? "";
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  if (url === "" || apiKey === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), apiKey };
}

function mbGet(ctx: SyncContext, creds: MetabaseCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.url}${path}`, {
    headers: { "x-api-key": creds.apiKey, Accept: "application/json" },
  });
}

function extractArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  const data = asRecord(parsed)?.["data"];
  return Array.isArray(data) ? data : [];
}

function extractCollectionNames(parsed: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of extractArray(parsed)) {
    const row = asRecord(c);
    if (row === undefined) {
      continue;
    }
    const idNum = numberField(row, "id");
    const idStr = stringField(row, "id");
    const key = idNum === undefined ? (idStr ?? "") : String(idNum);
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
    ctx.upsertItem(mapped);
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

      const collectionsOutcome = await mbGet(ctx, creds, "/api/collection");
      let totalBytes = collectionsOutcome.bytes;
      const collectionNames =
        collectionsOutcome.kind === "ok" ? extractCollectionNames(collectionsOutcome.parsed) : {};

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
