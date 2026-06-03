import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import {
  type CodemagicMappedRow,
  mapCodemagicAppToItem,
  mapCodemagicBuildToItem,
} from "./codemagic-build-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureCodemagicMcpRunning();
      const token = (await readConnectorSecret(ctx.vault, "codemagic", "token"))?.trim() ?? "";
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const appsOutcome = await connectorFetch(ctx, SERVICE_ID, `${CODEMAGIC_API}/apps`, {
        headers: { "x-auth-token": token, Accept: "application/json" },
      });
      if (appsOutcome.kind === "http_error") {
        return syncPassCursorHttpEmpty(t0, appsOutcome.bytes, cursor, pass1Cursor());
      }
      if (appsOutcome.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, appsOutcome.bytes, pass1Cursor());
      }

      const apps = extractRows(appsOutcome.parsed, "applications");
      const now = Date.now();
      let upserted = 0;
      let totalBytes = appsOutcome.bytes;

      for (const appRow of apps) {
        const mappedApp = mapCodemagicAppToItem(appRow, now);
        if (mappedApp !== null) {
          upsertItem(ctx, mappedApp);
          upserted += 1;
        }
        const id = appId(appRow);
        if (id === undefined) {
          continue;
        }
        const buildsOutcome = await connectorFetch(
          ctx,
          SERVICE_ID,
          `${CODEMAGIC_API}/builds?appId=${encodeURIComponent(id)}&limit=${String(DEFAULT_BUILDS_PAGE_SIZE)}`,
          { headers: { "x-auth-token": token, Accept: "application/json" } },
        );
        totalBytes += buildsOutcome.bytes;
        if (buildsOutcome.kind !== "ok") {
          continue;
        }
        for (const build of extractRows(buildsOutcome.parsed, "builds")) {
          const mapped = mapCodemagicBuildToItem(build, { appId: id, syncedAt: now });
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

function upsertItem(ctx: SyncContext, mapped: CodemagicMappedRow): void {
  upsertIndexedItemForSync(ctx, mapped);
}
