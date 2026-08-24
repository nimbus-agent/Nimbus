import { type AppStoreConnectJwtParams, signAppStoreConnectJwt } from "@nimbus-dev/sdk";

import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { runPerAppPollSync } from "./_lib/per-app-poll-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapTestflightAppToItem, mapTestflightBuildToItem } from "./testflight-build-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/** App Store Connect Bearer auth headers — a fresh ES256 JWT per sync pass. */
function testflightAuthHeaders(params: AppStoreConnectJwtParams): Record<string, string> {
  return { Authorization: `Bearer ${signAppStoreConnectJwt(params)}`, Accept: "application/json" };
}

const SERVICE_ID = "testflight";
const CURSOR_PREFIX = "nimbus-testflight1:";
const APPSTORECONNECT_API = "https://api.appstoreconnect.apple.com";
const DEFAULT_BUILDS_PAGE_SIZE = 50;

type TestflightCursorV1 = { pass: number };

function encodeCursor(c: TestflightCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type TestflightSyncableOptions = {
  ensureTestflightMcpRunning: () => Promise<void>;
};

/** Read the JSON:API top-level `data` array as an array of resource records. */
function extractData(parsed: unknown): Record<string, unknown>[] {
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

function resourceId(row: Record<string, unknown>): string | undefined {
  const id = stringField(row, "id");
  return id === undefined || id === "" ? undefined : id;
}

async function readJwtParams(ctx: SyncContext): Promise<AppStoreConnectJwtParams | null> {
  const issuerId = (await ctx.getSecret("issuer_id"))?.trim() ?? "";
  const keyId = (await ctx.getSecret("key_id"))?.trim() ?? "";
  const privateKeyPem = (await ctx.getSecret("private_key")) ?? "";
  if (issuerId === "" || keyId === "" || privateKeyPem.trim() === "") {
    return null;
  }
  return { issuerId, keyId, privateKeyPem };
}

export function createTestflightSyncable(options: TestflightSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runPerAppPollSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureTestflightMcpRunning,
        loadCreds: readJwtParams,
        pass1Cursor,
        appsUrl: () => `${APPSTORECONNECT_API}/v1/apps`,
        makeHeaders: testflightAuthHeaders,
        extractApps: extractData,
        getAppId: resourceId,
        buildsUrl: (id) =>
          `${APPSTORECONNECT_API}/v1/builds?filter[app]=${encodeURIComponent(id)}&sort=-uploadedDate&limit=${String(DEFAULT_BUILDS_PAGE_SIZE)}`,
        extractBuilds: extractData,
        mapApp: (row, now) => mapTestflightAppToItem(row, now),
        mapBuild: (buildRow, appRow, id, now) => {
          const appName = stringField(asRecord(appRow["attributes"]) ?? {}, "name");
          return mapTestflightBuildToItem(buildRow, { appId: id, appName, syncedAt: now });
        },
      });
    },
  };
}
