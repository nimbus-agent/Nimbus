import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import {
  type BitriseMappedRow,
  mapBitriseAppToItem,
  mapBitriseBuildToItem,
} from "./bitrise-build-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function bitriseGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${BITRISE_API}${path}`, {
    headers: { Authorization: token, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "bitrise GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractAppRows(parsed: unknown): Record<string, unknown>[] {
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
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureBitriseMcpRunning();
      const token = (await readConnectorSecret(ctx.vault, "bitrise", "token"))?.trim() ?? "";
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const appsOutcome = await bitriseGet(ctx, token, "/v0.1/me/apps?limit=50");
      if (appsOutcome.kind === "http_error") {
        return syncPassCursorHttpEmpty(t0, appsOutcome.bytes, cursor, pass1Cursor());
      }
      if (appsOutcome.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, appsOutcome.bytes, pass1Cursor());
      }

      const apps = extractAppRows(appsOutcome.parsed);
      const now = Date.now();
      let upserted = 0;
      let totalBytes = appsOutcome.bytes;

      for (const appRow of apps) {
        const mappedApp = mapBitriseAppToItem(appRow, now);
        if (mappedApp !== null) {
          upsertItem(ctx, mappedApp);
          upserted += 1;
        }
        const slug = appSlug(appRow);
        if (slug === undefined) {
          continue;
        }
        const buildsOutcome = await bitriseGet(
          ctx,
          token,
          `/v0.1/apps/${encodeURIComponent(slug)}/builds?limit=${String(DEFAULT_BUILDS_PAGE_SIZE)}`,
        );
        totalBytes += buildsOutcome.bytes;
        if (buildsOutcome.kind !== "ok") {
          continue;
        }
        for (const build of extractAppRows(buildsOutcome.parsed)) {
          const mapped = mapBitriseBuildToItem(build, { appSlug: slug, syncedAt: now });
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

function upsertItem(ctx: SyncContext, mapped: BitriseMappedRow): void {
  upsertIndexedItemForSync(ctx, mapped);
}
