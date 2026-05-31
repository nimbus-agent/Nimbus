import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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
  const token = (await readConnectorSecret(ctx.vault, "intercom", "token"))?.trim() ?? "";
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

function upsertConversations(
  ctx: SyncContext,
  conversations: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const conv of conversations) {
    const mapped = mapIntercomConversationToItem(conv, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createIntercomSyncable(options: IntercomSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureIntercomMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let startingAfter: string | null = null;

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await intercomGet(ctx, creds, conversationsPath(startingAfter));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { conversations, nextCursor } = extractConversations(outcome.parsed);
        totalUpserted += upsertConversations(ctx, conversations, now);

        if (nextCursor === null) {
          break;
        }
        startingAfter = nextCursor;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
