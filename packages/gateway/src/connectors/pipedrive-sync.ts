import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapPipedriveDealToItem } from "./pipedrive-deal-mapping.ts";
import { asRecord } from "./unknown-record.ts";

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

/**
 * `pipedrive.token` is required. Pipedrive's API host is a fixed SaaS host
 * (`api.pipedrive.com`) — there is no host override key. The connector no-ops
 * unless the token is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<PipedriveCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "pipedrive", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/**
 * Build the FULL deals URL including the `api_token=<token>` query parameter.
 *
 * SECURITY: Pipedrive authenticates with the token IN THE QUERY STRING — there
 * is no Authorization header — so the returned URL contains the secret. The
 * caller MUST NEVER log this URL or place it (or anything derived from it) into
 * an Error/audit/log line. The `start` offset is Pipedrive's forward cursor.
 */
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
    // Log only the status + resource — NEVER the URL (it carries the token in
    // the query string) and NEVER the body (it could be large). The `start`
    // offset is token-free, so it is safe to surface for diagnostics.
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, start }, "pipedrive GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /v1/deals` returns the Pipedrive envelope
 * `{ success, data: [...] | null, additional_data: { pagination: {
 * more_items_in_collection, next_start? } } }`. Extract the data array (a null
 * `data` is treated as empty), the `more_items_in_collection` flag, and the
 * `next_start` offset defensively — a missing/malformed envelope yields an
 * empty page with `moreItems: false` so the walk terminates.
 */
function extractDeals(parsed: unknown): {
  deals: unknown[];
  moreItems: boolean;
  nextStart: number | null;
} {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { deals: [], moreItems: false, nextStart: null };
  }
  const data = root["data"];
  const deals = Array.isArray(data) ? data : [];
  const additional = asRecord(root["additional_data"]);
  const pagination = additional === undefined ? undefined : asRecord(additional["pagination"]);
  const moreItems = pagination !== undefined && pagination["more_items_in_collection"] === true;
  const nextRaw = pagination?.["next_start"];
  const nextStart = typeof nextRaw === "number" && Number.isFinite(nextRaw) ? nextRaw : null;
  return { deals, moreItems, nextStart };
}

function upsertDeals(ctx: SyncContext, deals: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const d of deals) {
    const mapped = mapPipedriveDealToItem(d, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createPipedriveSyncable(options: PipedriveSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensurePipedriveMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let start = 0;

      // The first deals page is the gating call: a FIRST-page http/parse error
      // maps to the pass-cursor-empty result (http keeps the prior cursor, parse
      // resets). Later-page errors just break, preserving whatever was already
      // collected. Pipedrive offset-paginates: pass `start=<next_start>` and
      // follow `more_items_in_collection` until it is false (or the MAX_PAGES
      // cap stops the walk). An empty page also terminates.
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await pipedriveGetDeals(ctx, creds, start);
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { deals, moreItems, nextStart } = extractDeals(outcome.parsed);
        totalUpserted += upsertDeals(ctx, deals, now);

        if (deals.length === 0 || !moreItems || nextStart === null) {
          break;
        }
        start = nextStart;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
