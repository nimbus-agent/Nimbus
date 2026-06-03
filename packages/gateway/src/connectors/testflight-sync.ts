import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  mapTestflightAppToItem,
  mapTestflightBuildToItem,
  type TestflightMappedRow,
} from "./testflight-build-mapping.ts";
import { type TestflightJwtParams, testflightAuthHeaders } from "./testflight-jwt.ts";
import { asRecord, stringField } from "./unknown-record.ts";

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

async function readJwtParams(ctx: SyncContext): Promise<TestflightJwtParams | null> {
  const issuerId = (await readConnectorSecret(ctx.vault, "testflight", "issuer_id"))?.trim() ?? "";
  const keyId = (await readConnectorSecret(ctx.vault, "testflight", "key_id"))?.trim() ?? "";
  const privateKeyPem = (await readConnectorSecret(ctx.vault, "testflight", "private_key")) ?? "";
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
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureTestflightMcpRunning();
      const jwtParams = await readJwtParams(ctx);
      if (jwtParams === null) {
        return syncNoopResult(cursor, t0);
      }
      const headers = testflightAuthHeaders(jwtParams);

      const appsOutcome = await connectorFetch(ctx, SERVICE_ID, `${APPSTORECONNECT_API}/v1/apps`, {
        headers,
      });
      if (appsOutcome.kind === "http_error") {
        return syncPassCursorHttpEmpty(t0, appsOutcome.bytes, cursor, pass1Cursor());
      }
      if (appsOutcome.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, appsOutcome.bytes, pass1Cursor());
      }

      const apps = extractData(appsOutcome.parsed);
      const now = Date.now();
      let upserted = 0;
      let totalBytes = appsOutcome.bytes;

      for (const appRow of apps) {
        const mappedApp = mapTestflightAppToItem(appRow, now);
        if (mappedApp !== null) {
          upsertItem(ctx, mappedApp);
          upserted += 1;
        }
        const id = resourceId(appRow);
        if (id === undefined) {
          continue;
        }
        const appName = stringField(asRecord(appRow["attributes"]) ?? {}, "name");
        const buildsUrl = `${APPSTORECONNECT_API}/v1/builds?filter[app]=${encodeURIComponent(id)}&sort=-uploadedDate&limit=${String(DEFAULT_BUILDS_PAGE_SIZE)}`;
        const buildsOutcome = await connectorFetch(ctx, SERVICE_ID, buildsUrl, { headers });
        totalBytes += buildsOutcome.bytes;
        if (buildsOutcome.kind !== "ok") {
          continue;
        }
        for (const build of extractData(buildsOutcome.parsed)) {
          const mapped = mapTestflightBuildToItem(build, { appId: id, appName, syncedAt: now });
          if (mapped === null) {
            continue;
          }
          upsertItem(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}

function upsertItem(ctx: SyncContext, mapped: TestflightMappedRow): void {
  upsertIndexedItemForSync(ctx, mapped);
}
