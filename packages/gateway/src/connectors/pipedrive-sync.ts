import type { Syncable, SyncContext } from "../sync/types.ts";
import type { FetchOutcome } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapPipedriveDealToItem } from "./pipedrive-deal-mapping.ts";
import { asRecord } from "./unknown-record.ts";

// connectorFetch opt-out: api_token is in the query string (Pipedrive auth model),
// so the helper's url-logging on http_error would leak the token. Keep bespoke
// pipedriveGetDeals so the warn log surfaces only { status, start }.
const SERVICE_ID = "pipedrive";
const CURSOR_PREFIX = "nimbus-pipedrive1:";
const BASE = "https://api.pipedrive.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type PipedriveCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies PipedriveCursorV1);
}

export type PipedriveSyncableOptions = {
  ensurePipedriveMcpRunning: () => Promise<void>;
};

interface PipedriveCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<PipedriveCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function dealsUrl(token: string, start: number): string {
  const params = new URLSearchParams({
    api_token: token,
    limit: String(PAGE_SIZE),
    start: String(start),
  });
  return `${BASE}/v1/deals?${params.toString()}`;
}

async function pipedriveGetDeals(
  ctx: SyncContext,
  creds: PipedriveCreds,
  start: number,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(dealsUrl(creds.token, start), {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, start }, "pipedrive GET failed");
    return { kind: "http_error", bytes: text.length, status: res.status };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function parsePipedrivePage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false, nextPageCursor: "" };
  }
  const data = root["data"];
  const deals = Array.isArray(data) ? data : [];
  const additional = asRecord(root["additional_data"]);
  const pagination = additional === undefined ? undefined : asRecord(additional["pagination"]);
  const moreItems = pagination?.["more_items_in_collection"] === true;
  const nextRaw = pagination?.["next_start"];
  const nextStart = typeof nextRaw === "number" && Number.isFinite(nextRaw) ? nextRaw : null;
  const hasMore = deals.length > 0 && moreItems && nextStart !== null;
  return { items: deals, hasMore, nextPageCursor: hasMore ? String(nextStart) : "" };
}

export function createPipedriveSyncable(options: PipedriveSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensurePipedriveMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, _page, pageCursor) =>
          pipedriveGetDeals(ctx, creds, pageCursor === "" ? 0 : Number(pageCursor)),
        parsePage: (parsed) => parsePipedrivePage(parsed),
        map: (raw, _creds, now) => mapPipedriveDealToItem(raw, { syncedAt: now }),
      }),
  };
}
