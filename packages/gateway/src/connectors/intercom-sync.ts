import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapIntercomConversationToItem } from "./intercom-conversation-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "intercom";
const CURSOR_PREFIX = "nimbus-intercom1:";
const BASE = "https://api.intercom.io";
const PAGE_SIZE = 150;
const MAX_PAGES = 20;

type IntercomCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies IntercomCursorV1);
}

export type IntercomSyncableOptions = {
  ensureIntercomMcpRunning: () => Promise<void>;
};

interface IntercomCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<IntercomCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function conversationsPath(startingAfter: string | null): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE) });
  if (startingAfter !== null) {
    params.set("starting_after", startingAfter);
  }
  return `/conversations?${params.toString()}`;
}

function intercomGet(ctx: SyncContext, creds: IntercomCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Intercom-Version": "2.11",
      Accept: "application/json",
    },
  });
}

function extractConversations(parsed: unknown): {
  conversations: unknown[];
  nextCursor: string | null;
} {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { conversations: [], nextCursor: null };
  }
  const data = root["conversations"];
  const conversations = Array.isArray(data) ? data : [];
  const pages = asRecord(root["pages"]);
  const next = pages === undefined ? undefined : asRecord(pages["next"]);
  const startingAfter = next === undefined ? undefined : next["starting_after"];
  const nextCursor =
    typeof startingAfter === "string" && startingAfter !== "" ? startingAfter : null;
  return { conversations, nextCursor };
}

function parseIntercomPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const { conversations, nextCursor } = extractConversations(parsed);
  return {
    items: conversations,
    hasMore: nextCursor !== null,
    nextPageCursor: nextCursor ?? "",
  };
}

export function createIntercomSyncable(options: IntercomSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureIntercomMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        // original loop: for (let page = 1; page <= MAX_PAGES; page += 1)
        fetchPage: (creds, _page, pageCursor) =>
          intercomGet(ctx, creds, conversationsPath(pageCursor === "" ? null : pageCursor)),
        parsePage: (parsed) => parseIntercomPage(parsed),
        map: (raw, _creds, now) => mapIntercomConversationToItem(raw, { syncedAt: now }),
      }),
  };
}
