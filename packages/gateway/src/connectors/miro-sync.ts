import { getValidMiroAccessToken } from "../auth/miro-access-token.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapMiroBoardToItem } from "./miro-board-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "miro";
const CURSOR_PREFIX = "nimbus-miro1:";
const BASE = "https://api.miro.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

type MiroCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MiroCursorV1);
}

export type MiroSyncableOptions = {
  ensureMiroMcpRunning: () => Promise<void>;
};

interface MiroCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<MiroCreds | null> {
  const raw = await ctx.getSecret("oauth");
  if (raw === null || raw === "") {
    return null;
  }
  let token: string;
  try {
    token = await getValidMiroAccessToken(ctx.vault);
  } catch {
    return null;
  }
  return token === "" ? null : { token };
}

function boardsPath(cursor: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== "") {
    params.set("cursor", cursor);
  }
  return `/v2/boards?${params.toString()}`;
}

function miroGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractBoards(parsed: unknown): unknown[] {
  const data = asRecord(parsed)?.["data"];
  return Array.isArray(data) ? data : [];
}

/** Miro's cursor: the top-level `cursor` field is the opaque token for the next page (absent at the end). */
function nextCursor(parsed: unknown): string {
  const cursor = asRecord(parsed)?.["cursor"];
  return typeof cursor === "string" && cursor !== "" ? cursor : "";
}

function parseMiroPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const boards = extractBoards(parsed);
  const cursor = nextCursor(parsed);
  return { items: boards, hasMore: boards.length > 0 && cursor !== "", nextPageCursor: cursor };
}

export function createMiroSyncable(options: MiroSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureMiroMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) => miroGet(ctx, creds.token, boardsPath(pageCursor)),
        parsePage: (parsed) => parseMiroPage(parsed),
        map: (raw, _creds, now) => mapMiroBoardToItem(raw, { syncedAt: now }),
      }),
  };
}
