import { deleteItemByServiceExternal } from "../../../index/item-store.ts";
import type { SyncContext } from "../../../sync/types.ts";
import {
  extractErrorMessage,
  fetchMessageMetadataOrNullOn404,
  fetchProfile,
  GMAIL_SERVICE_ID,
  gmailFetchJson,
  type HistoryListResponse,
  type HistoryRecord,
  headerFrom,
  parseHistoryList,
  upsertGmailMessage,
} from "./api.ts";

async function gmailHistoryApplyAdded(
  ctx: SyncContext,
  accessToken: string,
  added: NonNullable<HistoryRecord["messagesAdded"]>,
  now: number,
): Promise<number> {
  let n = 0;

  const batchResults = await Promise.all(
    added.map(async (a) => {
      const m = a.message;
      if (m === undefined) {
        return null;
      }
      const mid = m.id;
      if (mid === undefined || mid === "") {
        return null;
      }
      const hasSubject = m.payload !== undefined && headerFrom(m.payload, "Subject") !== null;
      if (hasSubject) {
        return { mid, full: m };
      } else {
        const full = await fetchMessageMetadataOrNullOn404(ctx, accessToken, mid);
        return { mid, full };
      }
    }),
  );

  for (const res of batchResults) {
    if (res === null) continue;
    const { mid, full } = res;
    if (full === null) {
      ctx.logger.warn(
        { service: GMAIL_SERVICE_ID, messageId: mid, stage: "delta" },
        "Gmail messages.get returned 404; skipping message",
      );
      continue;
    }
    upsertGmailMessage(ctx, full, now);
    n += 1;
  }
  return n;
}

function gmailHistoryApplyDeleted(
  ctx: SyncContext,
  deleted: NonNullable<HistoryRecord["messagesDeleted"]>,
): number {
  let n = 0;
  for (const d of deleted) {
    const mid = d.message?.id;
    if (typeof mid === "string" && mid !== "") {
      deleteItemByServiceExternal(ctx.db, GMAIL_SERVICE_ID, mid);
      n += 1;
    }
  }
  return n;
}

export async function applyGmailHistoryRecords(
  ctx: SyncContext,
  accessToken: string,
  now: number,
  historyJson: unknown,
): Promise<{
  itemsUpserted: number;
  itemsDeleted: number;
  hist: HistoryListResponse;
}> {
  const hist = parseHistoryList(historyJson);
  const records = hist.history ?? [];
  let itemsUpserted = 0;
  let itemsDeleted = 0;
  for (const rec of records) {
    itemsUpserted += await gmailHistoryApplyAdded(ctx, accessToken, rec.messagesAdded ?? [], now);
    itemsDeleted += gmailHistoryApplyDeleted(ctx, rec.messagesDeleted ?? []);
  }
  return { itemsUpserted, itemsDeleted, hist };
}

export async function fetchGmailHistoryOrReset(
  ctx: SyncContext,
  accessToken: string,
  decoded: { startHistoryId: string; pageToken: string | null },
): Promise<{ kind: "ok"; json: unknown; bytes: number } | { kind: "reset" }> {
  const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  u.searchParams.set("startHistoryId", decoded.startHistoryId);
  u.searchParams.set("maxResults", "100");
  if (decoded.pageToken !== null && decoded.pageToken !== "") {
    u.searchParams.set("pageToken", decoded.pageToken);
  }
  for (const ht of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const) {
    u.searchParams.append("historyTypes", ht);
  }
  try {
    const res = await gmailFetchJson(ctx, accessToken, u.toString());
    return { kind: "ok", json: res.json, bytes: res.bytes };
  } catch (e) {
    if (extractErrorMessage(e).includes("404")) {
      ctx.logger.warn(
        { service: GMAIL_SERVICE_ID },
        "Gmail history expired or invalid; resetting list sync",
      );
      return { kind: "reset" };
    }
    throw e;
  }
}

export async function resolveDeltaHistoryId(
  ctx: SyncContext,
  accessToken: string,
  candidate: string | undefined,
): Promise<string> {
  if (typeof candidate === "string" && candidate !== "") {
    return candidate;
  }
  const profile = await fetchProfile(ctx, accessToken);
  const fallback = profile.historyId;
  if (typeof fallback !== "string" || fallback === "") {
    throw new Error("Gmail sync failed: history response missing historyId");
  }
  return fallback;
}
