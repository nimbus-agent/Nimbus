import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapReadwiseHighlightToItem } from "./readwise-highlight-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "readwise";
const CURSOR_PREFIX = "nimbus-readwise1:";
const BASE = "https://readwise.io";
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type ReadwiseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ReadwiseCursorV1);
}

export type ReadwiseSyncableOptions = {
  ensureReadwiseMcpRunning: () => Promise<void>;
};

interface ReadwiseCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<ReadwiseCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "readwise", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function highlightsPath(page: number): string {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE), page: String(page) });
  return `/api/v2/highlights/?${params.toString()}`;
}

function readwiseGet(ctx: SyncContext, creds: ReadwiseCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Token ${creds.token}`, Accept: "application/json" },
  });
}

function parseReadwisePage(parsed: unknown): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const results = root["results"];
  const items = Array.isArray(results) ? results : [];
  const nextRaw = root["next"];
  const next = typeof nextRaw === "string" && nextRaw !== "" ? nextRaw : null;
  return { items, hasMore: items.length > 0 && next !== null };
}

export function createReadwiseSyncable(options: ReadwiseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureReadwiseMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => readwiseGet(ctx, creds, highlightsPath(page)),
        parsePage: (parsed) => parseReadwisePage(parsed),
        map: (raw, _creds, now) => mapReadwiseHighlightToItem(raw, { syncedAt: now }),
      }),
  };
}
