import { getValidCanvaAccessToken } from "../auth/canva-access-token.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapCanvaDesignToItem } from "./canva-design-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "canva";
const CURSOR_PREFIX = "nimbus-canva1:";
const BASE = "https://api.canva.com";
const MAX_PAGES = 20;

type CanvaCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies CanvaCursorV1);
}

export type CanvaSyncableOptions = {
  ensureCanvaMcpRunning: () => Promise<void>;
};

interface CanvaCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<CanvaCreds | null> {
  const raw = await ctx.getSecret("oauth");
  if (raw === null || raw === "") {
    return null;
  }
  let token: string;
  try {
    token = await getValidCanvaAccessToken(ctx.vault);
  } catch {
    return null;
  }
  return token === "" ? null : { token };
}

function designsPath(continuation: string): string {
  const params = new URLSearchParams();
  if (continuation !== "") {
    params.set("continuation", continuation);
  }
  const qs = params.toString();
  const query = qs === "" ? "" : `?${qs}`;
  return `/rest/v1/designs${query}`;
}

function canvaGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractDesigns(parsed: unknown): unknown[] {
  const items = asRecord(parsed)?.["items"];
  return Array.isArray(items) ? items : [];
}

/** Canva's cursor: the top-level `continuation` field is the opaque token for the next page (absent at the end). */
function nextContinuation(parsed: unknown): string {
  const c = asRecord(parsed)?.["continuation"];
  return typeof c === "string" && c !== "" ? c : "";
}

function parseCanvaPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const designs = extractDesigns(parsed);
  const continuation = nextContinuation(parsed);
  return {
    items: designs,
    hasMore: designs.length > 0 && continuation !== "",
    nextPageCursor: continuation,
  };
}

export function createCanvaSyncable(options: CanvaSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureCanvaMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) =>
          canvaGet(ctx, creds.token, designsPath(pageCursor)),
        parsePage: (parsed) => parseCanvaPage(parsed),
        map: (raw, _creds, now) => mapCanvaDesignToItem(raw, { syncedAt: now }),
      }),
  };
}
