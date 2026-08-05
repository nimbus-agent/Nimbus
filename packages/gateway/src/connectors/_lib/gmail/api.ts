import { type IndexedItemBodyInput, upsertIndexedItemForSync } from "../../../index/item-store.ts";
import { resolvePersonForSync } from "../../../people/linker.ts";
import { parseFromHeaderForPerson } from "../../../people/parse-from-header.ts";
import { stripQuotedTail } from "../../../string/email-quoted-text.ts";
import type { SyncContext } from "../../../sync/types.ts";
import { fetchGoogleJson } from "../../google-sync-shared.ts";
import { asUnknownObjectRecord } from "../../json-unknown.ts";
import { gmailMessageBodyText } from "./message-body.ts";

export const GMAIL_SERVICE_ID = "gmail";

export type MessageListEntry = { id?: string; threadId?: string };

export type MessagesListResponse = {
  messages?: MessageListEntry[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type MessageHeader = { name?: string; value?: string };

export type MessagePartBody = {
  data?: string;
  /** Present when the bytes live in a separate attachment fetch — skip these. */
  attachmentId?: string;
};

export type MessagePayload = {
  mimeType?: string;
  headers?: MessageHeader[];
  body?: MessagePartBody;
  parts?: MessagePayload[];
};

export type GmailMessageResource = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: MessagePayload;
};

export type HistoryRecord = {
  id?: string;
  messages?: Array<{ id?: string; threadId?: string }>;
  messagesAdded?: Array<{ message?: GmailMessageResource }>;
  messagesDeleted?: Array<{ message?: { id?: string } }>;
};

export type HistoryListResponse = {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
};

export type ProfileResponse = {
  emailAddress?: string;
  historyId?: string;
  messagesTotal?: number;
};

export function gmailFetchJson(
  ctx: SyncContext,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<{ json: unknown; bytes: number }> {
  return fetchGoogleJson(ctx, token, url, "Gmail", init);
}

export function listQueryForInitial(days: number): string {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  return `newer_than:${String(d)}d`;
}

export async function fetchMessageMetadata(
  ctx: SyncContext,
  token: string,
  messageId: string,
): Promise<GmailMessageResource> {
  const u = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  u.searchParams.set("format", "full");
  const { json } = await gmailFetchJson(ctx, token, u.toString());
  return asUnknownObjectRecord(json);
}

export function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return "Request failed";
}

export async function fetchMessageMetadataOrNullOn404(
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

export async function fetchProfile(ctx: SyncContext, token: string): Promise<ProfileResponse> {
  const { json } = await gmailFetchJson(
    ctx,
    token,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  );
  return asUnknownObjectRecord(json);
}

export function parseMessagesList(json: unknown): MessagesListResponse {
  return asUnknownObjectRecord(json);
}

export function parseHistoryList(json: unknown): HistoryListResponse {
  return asUnknownObjectRecord(json);
}

export function headerFrom(payload: MessagePayload | undefined, name: string): string | null {
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

export function upsertGmailMessage(ctx: SyncContext, m: GmailMessageResource, now: number): void {
  const id = m.id;
  if (id === undefined || id === "") {
    return;
  }
  const subject = headerFrom(m.payload, "Subject") ?? "(no subject)";
  const rawBody = gmailMessageBodyText(m.payload ?? {});
  const body = stripQuotedTail(rawBody);
  // Empty-body handling is a PAIR with `connectors/outlook-sync.ts` — keep
  // the two arms in step. `gmailMessageBodyText` legitimately yields nothing
  // for S/MIME mail, attachment-only mail, an unusual MIME shape, or a tree
  // exceeding its MAX_DEPTH / MAX_PARTS bounds. Passing `body: ""` there
  // would be a DECLARED-full empty body: `upsertIndexedItem` sees
  // `declaredFull = true`, raw length 0 <= cap and no `bodyTruncated`, so it
  // latches `body_complete = 1` — the message loses the snippet it used to
  // have AND is marked complete, so `index.rebody` never revisits it. The
  // `bodyPreview` arm keeps the snippet searchable at `body_complete = 0`.
  const snippet = typeof m.snippet === "string" ? m.snippet : "";
  const bodyInput: IndexedItemBodyInput = body === "" ? { bodyPreview: snippet } : { body };
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
    service: GMAIL_SERVICE_ID,
    type: "email",
    externalId: id,
    title: subject.length > 512 ? subject.slice(0, 512) : subject,
    ...bodyInput,
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
