import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapStackOverflowQuestionToItem } from "./stackoverflow-question-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "stackoverflow";
const CURSOR_PREFIX = "nimbus-stackoverflow1:";
const BASE = "https://api.stackoverflowteams.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type StackOverflowCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies StackOverflowCursorV1);
}

export type StackOverflowSyncableOptions = {
  ensureStackOverflowMcpRunning: () => Promise<void>;
};

interface StackOverflowCreds {
  readonly token: string;
  readonly team: string;
}

async function loadCreds(ctx: SyncContext): Promise<StackOverflowCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  const team = (await ctx.getSecret("team"))?.trim() ?? "";
  if (token === "" || team === "") {
    return null;
  }
  return { token, team };
}

function questionsPath(team: string, page: number): string {
  const params = new URLSearchParams({
    page: String(page),
    pagesize: String(PAGE_SIZE),
    sort: "creation",
    order: "desc",
  });
  return `/v3/teams/${encodeURIComponent(team)}/questions?${params.toString()}`;
}

function stackOverflowGet(ctx: SyncContext, creds: StackOverflowCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

function parseStackOverflowPage(
  parsed: unknown,
  page: number,
): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const rawItems = root["items"];
  const items = Array.isArray(rawItems) ? rawItems : [];
  const totalPagesRaw = root["totalPages"];
  const totalPages =
    typeof totalPagesRaw === "number" && Number.isFinite(totalPagesRaw) ? totalPagesRaw : 0;
  return { items, hasMore: items.length > 0 && page < totalPages };
}

export function createStackOverflowSyncable(options: StackOverflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureStackOverflowMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => stackOverflowGet(ctx, creds, questionsPath(creds.team, page)),
        parsePage: (parsed, page) => parseStackOverflowPage(parsed, page),
        map: (raw, _creds, now) => mapStackOverflowQuestionToItem(raw, { syncedAt: now }),
      }),
  };
}
