import { getValidGoogleAccessToken } from "../auth/google-access-token.ts";
import { deleteItemByServiceExternal, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { parseFromHeaderForPerson } from "../people/parse-from-header.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { fetchGoogleJson } from "./google-sync-shared.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "gmail";
const CURSOR_PREFIX = "nimbus-gml1:";
const LIST_PAGE_SIZE = 50;

type MessageListEntry = { id?: string; threadId?: string };

type MessagesListResponse = {
  messages?: MessageListEntry[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type MessageHeader = { name?: string; value?: string };

type MessagePayload = {
  mimeType?: string;
  headers?: MessageHeader[];
};

type GmailMessageResource = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: MessagePayload;
};

type HistoryRecord = {
  id?: string;
  messages?: Array<{ id?: string; threadId?: string }>;
  messagesAdded?: Array<{ message?: GmailMessageResource }>;
  messagesDeleted?: Array<{ message?: { id?: string } }>;
};

type HistoryListResponse = {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
};

type ProfileResponse = {
  emailAddress?: string;
  historyId?: string;
  messagesTotal?: number;
};

export type GmailSyncCursorV1 =
  | { v: 1; phase: "list"; q: string; pageToken: string | null }
  | { v: 1; phase: "delta"; startHistoryId: string; pageToken: string | null };

export function encodeGmailSyncCursor(c: GmailSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeGmailListPhasePayload(r: Record<string, unknown>): GmailSyncCursorV1 | undefined {
  const q = r["q"];
  const pageToken = r["pageToken"];
  if (typeof q !== "string") {
    return undefined;
  }
  if (pageToken !== null && typeof pageToken !== "string") {
    return undefined;
  }
  return { v: 1, phase: "list", q, pageToken };
}

function decodeGmailDeltaPhasePayload(r: Record<string, unknown>): GmailSyncCursorV1 | undefined {
  const startHistoryId = r["startHistoryId"];
  const pageToken = r["pageToken"];
  if (typeof startHistoryId !== "string" || startHistoryId === "") {
    return undefined;
  }
  if (pageToken !== null && typeof pageToken !== "string") {
    return undefined;
  }
  return {
    v: 1,
    phase: "delta",
    startHistoryId,
    pageToken,
  };
}

export function decodeGmailSyncCursor(raw: string): GmailSyncCursorV1 | undefined {
  const o = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (o == null || typeof o !== "object" || Array.isArray(o)) {
    return undefined;
  }
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) {
    return undefined;
  }
  const phase = r["phase"];
  if (phase === "list") {
    return decodeGmailListPhasePayload(r);
  }
  if (phase === "delta") {
    return decodeGmailDeltaPhasePayload(r);
  }
  return undefined;
}

function headerFrom(payload: MessagePayload | undefined, name: string): string | null {
  const headers = payload?.headers;
  if (!Array.isArray(headers)) {
    return null;
  }
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (
      typeof h?.name === "string" &&
      h.name.toLowerCase() === lower &&
      typeof h.value === "string"
    ) {
      return h.value;
    }
  }
  return null;
}

function upsertGmailMessage(ctx: SyncContext, m: GmailMessageResource, now: number): void {
  const id = m.id;
  if (id === undefined || id === "") {
    return;
  }
  const subject = headerFrom(m.payload, "Subject") ?? "(no subject)";
  const snippet = typeof m.snippet === "string" ? m.snippet : "";
  const preview = snippet.length > 512 ? snippet.slice(0, 512) : snippet;
  const internal = m.internalDate === undefined ? now : Number(m.internalDate);
  const modifiedAt = Number.isFinite(internal) ? internal : now;
  const threadId = typeof m.threadId === "string" ? m.threadId : "";
  const from = headerFrom(m.payload, "From");
  const to = headerFrom(m.payload, "To");
  const fromParsed = parseFromHeaderForPerson(from);
  const authorId =
    fromParsed.email === undefined
      ? null
      : resolvePersonForSync(ctx.db, {
          canonicalEmail: fromParsed.email,
          ...(fromParsed.displayName === undefined ? {} : { displayName: fromParsed.displayName }),
        });
  const url =
    threadId === ""
      ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`
      : `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;

  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "email",
    externalId: id,
    title: subject.length > 512 ? subject.slice(0, 512) : subject,
    bodyPreview: preview,
    url,
    canonicalUrl: url,
    modifiedAt,
    authorId,
    metadata: {
      threadId: threadId === "" ? undefined : threadId,
      labelIds: m.labelIds,
      from,
      to,
    },
    pinned: false,
    syncedAt: now,
  });
}

function gmailFetchJson(
  ctx: SyncContext,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<{ json: unknown; bytes: number }> {
  return fetchGoogleJson(ctx, token, url, "Gmail", init);
}

function listQueryForInitial(days: number): string {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  return `newer_than:${String(d)}d`;
}

async function fetchMessageMetadata(
  ctx: SyncContext,
  token: string,
  messageId: string,
): Promise<GmailMessageResource> {
  const u = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  u.searchParams.set("format", "metadata");
  u.searchParams.append("metadataHeaders", "Subject");
  u.searchParams.append("metadataHeaders", "From");
  u.searchParams.append("metadataHeaders", "To");
  const { json } = await gmailFetchJson(ctx, token, u.toString());
  return asUnknownObjectRecord(json) as GmailMessageResource;
}

async function fetchMessageMetadataOrNullOn404(
  ctx: SyncContext,
  token: string,
  messageId: string,
): Promise<GmailMessageResource | null> {
  try {
    return await fetchMessageMetadata(ctx, token, messageId);
  } catch (e) {
    if (extractErrorMessage(e).includes("sync failed: 404")) {
      return null;
    }
    throw e;
  }
}

async function fetchProfile(ctx: SyncContext, token: string): Promise<ProfileResponse> {
  const { json } = await gmailFetchJson(
    ctx,
    token,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  );
  return asUnknownObjectRecord(json) as ProfileResponse;
}

function parseMessagesList(json: unknown): MessagesListResponse {
  return asUnknownObjectRecord(json) as MessagesListResponse;
}

function parseHistoryList(json: unknown): HistoryListResponse {
  return asUnknownObjectRecord(json) as HistoryListResponse;
}

async function gmailHistoryApplyAdded(
  ctx: SyncContext,
  accessToken: string,
  added: NonNullable<HistoryRecord["messagesAdded"]>,
  now: number,
): Promise<number> {
  let n = 0;
  for (const a of added) {
    const m = a.message;
    if (m === undefined) {
      continue;
    }
    const mid = m.id;
    if (mid === undefined || mid === "") {
      continue;
    }
    const hasSubject = m.payload !== undefined && headerFrom(m.payload, "Subject") !== null;
    let full: GmailMessageResource | null;
    if (hasSubject) {
      full = m;
    } else {
      full = await fetchMessageMetadataOrNullOn404(ctx, accessToken, mid);
      if (full === null) {
        ctx.logger.warn(
          { service: SERVICE_ID, messageId: mid, stage: "delta" },
          "Gmail messages.get returned 404; skipping message",
        );
        continue;
      }
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
      deleteItemByServiceExternal(ctx.db, SERVICE_ID, mid);
      n += 1;
    }
  }
  return n;
}

async function applyGmailHistoryRecords(
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

export type GmailSyncableOptions = {
  ensureGoogleMcpRunning: () => Promise<void>;
};

export function createGmailSyncable(options: GmailSyncableOptions): Syncable {
  const ensure = options.ensureGoogleMcpRunning;
  const initialSyncDepthDays = 30;

  return {
    serviceId: SERVICE_ID,
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
        for (const e of entries) {
          const mid = e.id;
          if (mid === undefined || mid === "") {
            continue;
          }
          const meta = await fetchMessageMetadataOrNullOn404(ctx, accessToken, mid);
          if (meta === null) {
            ctx.logger.warn(
              { service: SERVICE_ID, messageId: mid, stage: "list" },
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

      if (!cursor.startsWith(CURSOR_PREFIX)) {
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

      return resolveGmailDeltaResult({
        ctx,
        accessToken,
        decoded,
        hist: applied.hist,
        itemsUpserted,
        itemsDeleted,
        bytesTransferred,
        startedAt,
      });
    },
  };
}

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return "Request failed";
}

async function fetchGmailHistoryOrReset(
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
        { service: SERVICE_ID },
        "Gmail history expired or invalid; resetting list sync",
      );
      return { kind: "reset" };
    }
    throw e;
  }
}

interface GmailDeltaResultArgs {
  ctx: SyncContext;
  accessToken: string;
  decoded: { startHistoryId: string };
  hist: { nextPageToken?: string; historyId?: string };
  itemsUpserted: number;
  itemsDeleted: number;
  bytesTransferred: number;
  startedAt: number;
}

async function resolveGmailDeltaResult(args: GmailDeltaResultArgs): Promise<SyncResult> {
  const { hist, itemsUpserted, itemsDeleted, bytesTransferred, startedAt, decoded } = args;
  const nextPage = hist.nextPageToken;
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
  const finalHid = await resolveDeltaHistoryId(args.ctx, args.accessToken, hist.historyId);
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
}

async function resolveDeltaHistoryId(
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
