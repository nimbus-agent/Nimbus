import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { runPerAppPollSync } from "./_lib/per-app-poll-sync.ts";
import { mapBitriseAppToItem, mapBitriseBuildToItem } from "./bitrise-build-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "bitrise";
const CURSOR_PREFIX = "nimbus-bitrise1:";
const BITRISE_API = "https://api.bitrise.io";
const DEFAULT_BUILDS_PAGE_SIZE = 50;

type BitriseCursorV1 = { pass: number };

function encodeCursor(c: BitriseCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type BitriseSyncableOptions = {
  ensureBitriseMcpRunning: () => Promise<void>;
};

function extractDataRows(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed) ?? {};
  const data = root["data"];
  if (!Array.isArray(data)) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const entry of data) {
    const row = asRecord(entry);
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return rows;
}

function appSlug(row: Record<string, unknown>): string | undefined {
  const slug = stringField(row, "slug");
  return slug === undefined || slug === "" ? undefined : slug;
}

export function createBitriseSyncable(options: BitriseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runPerAppPollSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureBitriseMcpRunning,
        async loadCreds(c: SyncContext) {
          const token = (await c.getSecret("token"))?.trim() ?? "";
          return token === "" ? null : token;
        },
        pass1Cursor,
        appsUrl: () => `${BITRISE_API}/v0.1/me/apps?limit=50`,
        makeHeaders: (token) => ({ Authorization: token, Accept: "application/json" }),
        extractApps: extractDataRows,
        getAppId: appSlug,
        buildsUrl: (slug) =>
          `${BITRISE_API}/v0.1/apps/${encodeURIComponent(slug)}/builds?limit=${String(DEFAULT_BUILDS_PAGE_SIZE)}`,
        extractBuilds: extractDataRows,
        mapApp: (row, now) => mapBitriseAppToItem(row, now),
        mapBuild: (buildRow, _appRow, slug, now) =>
          mapBitriseBuildToItem(buildRow, { appSlug: slug, syncedAt: now }),
      });
    },
  };
}
