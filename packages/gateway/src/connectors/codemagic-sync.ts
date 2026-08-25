import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { runPerAppPollSync } from "./_lib/per-app-poll-sync.ts";
import { mapCodemagicAppToItem, mapCodemagicBuildToItem } from "./codemagic-build-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "codemagic";
const CURSOR_PREFIX = "nimbus-codemagic1:";
const CODEMAGIC_API = "https://api.codemagic.io";
const DEFAULT_BUILDS_PAGE_SIZE = 50;

type CodemagicCursorV1 = { pass: number };

function encodeCursor(c: CodemagicCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type CodemagicSyncableOptions = {
  ensureCodemagicMcpRunning: () => Promise<void>;
};

function extractRows(parsed: unknown, key: string): Record<string, unknown>[] {
  const root = asRecord(parsed) ?? {};
  const data = root[key];
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

function appId(row: Record<string, unknown>): string | undefined {
  const id = stringField(row, "_id");
  return id === undefined || id === "" ? undefined : id;
}

export function createCodemagicSyncable(options: CodemagicSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runPerAppPollSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureCodemagicMcpRunning,
        async loadCreds(c: SyncContext) {
          const token = (await c.getSecret("token"))?.trim() ?? "";
          return token === "" ? null : token;
        },
        pass1Cursor,
        appsUrl: () => `${CODEMAGIC_API}/apps`,
        makeHeaders: (token) => ({ "x-auth-token": token, Accept: "application/json" }),
        extractApps: (parsed) => extractRows(parsed, "applications"),
        getAppId: appId,
        buildsUrl: (id) =>
          `${CODEMAGIC_API}/builds?appId=${encodeURIComponent(id)}&limit=${String(DEFAULT_BUILDS_PAGE_SIZE)}`,
        extractBuilds: (parsed) => extractRows(parsed, "builds"),
        mapApp: (row, now) => mapCodemagicAppToItem(row, now),
        mapBuild: (buildRow, _appRow, id, now) =>
          mapCodemagicBuildToItem(buildRow, { appId: id, syncedAt: now }),
      });
    },
  };
}
