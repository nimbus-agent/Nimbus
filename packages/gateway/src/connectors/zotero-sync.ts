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
import { mapZoteroReferenceToItem } from "./zotero-reference-mapping.ts";

const SERVICE_ID = "zotero";
const CURSOR_PREFIX = "nimbus-zotero1:";
const BASE = "https://api.zotero.org";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type ZoteroCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ZoteroCursorV1);
}

export type ZoteroSyncableOptions = {
  ensureZoteroMcpRunning: () => Promise<void>;
};

interface ZoteroCreds {
  readonly apiKey: string;
  readonly library: string;
}

async function loadCreds(ctx: SyncContext): Promise<ZoteroCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "zotero", "api_key"))?.trim() ?? "";
  const library = (await readConnectorSecret(ctx.vault, "zotero", "library"))?.trim() ?? "";
  if (apiKey === "" || library === "") {
    return null;
  }
  return { apiKey, library };
}

function itemsPath(library: string, start: number): string {
  const params = new URLSearchParams({
    format: "json",
    limit: String(PAGE_SIZE),
    start: String(start),
    sort: "dateModified",
    direction: "desc",
  });
  return `/${library}/items?${params.toString()}`;
}

function zoteroGet(ctx: SyncContext, creds: ZoteroCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: {
      "Zotero-API-Key": creds.apiKey,
      "Zotero-API-Version": "3",
      Accept: "application/json",
    },
  });
}

function extractItems(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function upsertItems(ctx: SyncContext, items: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const it of items) {
    const mapped = mapZoteroReferenceToItem(it, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createZoteroSyncable(options: ZoteroSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureZoteroMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const start = page * PAGE_SIZE;
        const outcome = await zoteroGet(ctx, creds, itemsPath(creds.library, start));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const items = extractItems(outcome.parsed);
        totalUpserted += upsertItems(ctx, items, now);

        if (items.length < PAGE_SIZE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
