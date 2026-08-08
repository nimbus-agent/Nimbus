import { getValidGoogleAccessToken } from "../auth/google-access-token.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  fetchMessageMetadataOrNullOn404,
  fetchProfile,
  GMAIL_SERVICE_ID,
  gmailFetchJson,
  listQueryForInitial,
  parseMessagesList,
  upsertGmailMessage,
} from "./_lib/gmail/api.ts";
import {
  decodeGmailSyncCursor,
  encodeGmailSyncCursor,
  GMAIL_CURSOR_PREFIX,
} from "./_lib/gmail/cursor.ts";
import {
  applyGmailHistoryRecords,
  fetchGmailHistoryOrReset,
  resolveDeltaHistoryId,
} from "./_lib/gmail/history.ts";

const LIST_PAGE_SIZE = 50;

export type { GmailSyncCursorV1 } from "./_lib/gmail/cursor.ts";
export { decodeGmailSyncCursor, encodeGmailSyncCursor };

export type GmailSyncableOptions = {
  ensureGoogleMcpRunning: () => Promise<void>;
};

export function createGmailSyncable(options: GmailSyncableOptions): Syncable {
  const ensure = options.ensureGoogleMcpRunning;
  const initialSyncDepthDays = 30;

  return {
    serviceId: GMAIL_SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays,

    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      await ensure();
      const startedAt = Date.now();
      const accessToken = await getValidGoogleAccessToken(ctx.vault, "gmail");
      const now = Date.now();
      let itemsUpserted = 0;
      let itemsDeleted = 0;
      let bytesTransferred = 0;

      const finishListPage = async (
        q: string,
        pageToken: string | undefined,
      ): Promise<SyncResult> => {
        const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        u.searchParams.set("maxResults", String(LIST_PAGE_SIZE));
        u.searchParams.set("q", q);
        if (pageToken !== undefined && pageToken !== "") {
          u.searchParams.set("pageToken", pageToken);
        }
        const { json, bytes } = await gmailFetchJson(ctx, accessToken, u.toString());
        bytesTransferred += bytes;
        const data = parseMessagesList(json);
        const entries = data.messages ?? [];
        const batchResults = await Promise.all(
          entries.map(async (e) => {
            const mid = e.id;
            if (mid === undefined || mid === "") {
              return null;
            }
            const meta = await fetchMessageMetadataOrNullOn404(ctx, accessToken, mid);
            return { e, mid, meta };
          }),
        );

        for (const res of batchResults) {
          if (res === null) continue;
          const { e, mid, meta } = res;
          if (meta === null) {
            ctx.logger.warn(
              { service: GMAIL_SERVICE_ID, messageId: mid, stage: "list" },
              "Gmail messages.get returned 404; skipping message",
            );
            continue;
          }
          meta.id = meta.id ?? mid;
          if (
            (meta.threadId === undefined || meta.threadId === "") &&
            typeof e.threadId === "string" &&
            e.threadId !== ""
          ) {
            meta.threadId = e.threadId;
          }
          upsertGmailMessage(ctx, meta, now);
          itemsUpserted += 1;
        }
        const next = data.nextPageToken;
        if (next !== undefined && next !== "") {
          return {
            cursor: encodeGmailSyncCursor({ v: 1, phase: "list", q, pageToken: next }),
            itemsUpserted,
            itemsDeleted,
            hasMore: true,
            durationMs: Date.now() - startedAt,
            bytesTransferred,
          };
        }
        const profile = await fetchProfile(ctx, accessToken);
        const hid = profile.historyId;
        if (typeof hid !== "string" || hid === "") {
          throw new Error("Gmail sync failed: profile missing historyId");
        }
        return {
          cursor: encodeGmailSyncCursor({
            v: 1,
            phase: "delta",
            startHistoryId: hid,
            pageToken: null,
          }),
          itemsUpserted,
          itemsDeleted,
          hasMore: false,
          durationMs: Date.now() - startedAt,
          bytesTransferred,
        };
      };

      if (cursor === null || cursor === "") {
        const q = listQueryForInitial(initialSyncDepthDays);
        return await finishListPage(q, undefined);
      }

      if (!cursor.startsWith(GMAIL_CURSOR_PREFIX)) {
        const q = listQueryForInitial(initialSyncDepthDays);
        return await finishListPage(q, undefined);
      }

      const decoded = decodeGmailSyncCursor(cursor);
      if (decoded === undefined) {
        throw new Error("Gmail sync: corrupt cursor");
      }

      if (decoded.phase === "list") {
        return await finishListPage(decoded.q, decoded.pageToken ?? undefined);
      }

      const fetched = await fetchGmailHistoryOrReset(ctx, accessToken, decoded);
      if (fetched.kind === "reset") {
        const q = listQueryForInitial(initialSyncDepthDays);
        return await finishListPage(q, undefined);
      }
      bytesTransferred += fetched.bytes;

      const applied = await applyGmailHistoryRecords(ctx, accessToken, now, fetched.json);
      itemsUpserted += applied.itemsUpserted;
      itemsDeleted += applied.itemsDeleted;

      const nextPage = applied.hist.nextPageToken;
      if (nextPage !== undefined && nextPage !== "") {
        return {
          cursor: encodeGmailSyncCursor({
            v: 1,
            phase: "delta",
            startHistoryId: decoded.startHistoryId,
            pageToken: nextPage,
          }),
          itemsUpserted,
          itemsDeleted,
          hasMore: true,
          durationMs: Date.now() - startedAt,
          bytesTransferred,
        };
      }
      const finalHid = await resolveDeltaHistoryId(ctx, accessToken, applied.hist.historyId);
      return {
        cursor: encodeGmailSyncCursor({
          v: 1,
          phase: "delta",
          startHistoryId: finalHid,
          pageToken: null,
        }),
        itemsUpserted,
        itemsDeleted,
        hasMore: false,
        durationMs: Date.now() - startedAt,
        bytesTransferred,
      };
    },
  };
}
