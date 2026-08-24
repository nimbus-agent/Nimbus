import {
  deleteItemByServiceExternal,
  type IndexedItemBodyInput,
  upsertIndexedItemForSync,
} from "../index/item-store.ts";
import { stripQuotedTail } from "../string/email-quoted-text.ts";
import { plainTextFromHtmlLines } from "../string/html-plain-text-lines.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  decodeMicrosoftGraphDeltaCursor,
  encodeMicrosoftGraphDeltaCursor,
  fetchMicrosoftGraphJson,
  type MicrosoftGraphDeltaCursorV1,
  modifiedMsFromIso,
  nextCursorFromODataDeltaLinks,
  parseODataDeltaPage,
} from "./microsoft-graph-sync-shared.ts";

const SERVICE_ID = "outlook";
// Bumped from "nimbus-outl1:" so every stored delta link is invalidated ONCE
// on upgrade. A stored @odata.deltaLink encodes the projection of the query
// that minted it, so an install following a pre-$select link would keep
// receiving body-less responses for EVERY message, including brand-new ones —
// the feature would be off, not merely incomplete. decodeMicrosoftGraphDeltaCursor
// returns undefined on a prefix mismatch and the sync does
// `nextUrl = dec?.nextUrl ?? null`, so an undecodable cursor falls through to
// the INITIAL request URL, which is where $select lives. One fresh delta, no
// new machinery, no error path.
const CURSOR_PREFIX = "nimbus-outl2:";
const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 50;

type GraphMessage = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  webLink?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  "@removed"?: { reason?: string };
};

export type OutlookSyncCursorV1 = MicrosoftGraphDeltaCursorV1;

export function encodeOutlookSyncCursor(c: OutlookSyncCursorV1): string {
  return encodeMicrosoftGraphDeltaCursor(CURSOR_PREFIX, c);
}

export function decodeOutlookSyncCursor(raw: string): OutlookSyncCursorV1 | undefined {
  return decodeMicrosoftGraphDeltaCursor(raw, CURSOR_PREFIX);
}

function upsertMessage(ctx: SyncContext, m: GraphMessage, now: number): void {
  const id = m.id;
  if (id === undefined || id === "") {
    return;
  }
  const subject = typeof m.subject === "string" && m.subject !== "" ? m.subject : "(no subject)";
  const raw = typeof m.body?.content === "string" ? m.body.content : "";
  // `parseODataDeltaPage` validates only the top-level `value` array and casts
  // each element to `GraphMessage` without runtime validation — this is
  // external JSON, so `contentType` can be any JSON type. A non-string here
  // (or absent) must fall through to the HTML path (the safe default: HTML
  // stripping on plain text is a no-op-ish pass through `plainTextFromHtmlLines`
  // that only collapses whitespace), not throw and abort the whole sync page.
  const contentType =
    typeof m.body?.contentType === "string" ? m.body.contentType.toLowerCase() : "";
  const text = contentType === "text" ? raw : plainTextFromHtmlLines(raw);
  const body = stripQuotedTail(text);
  // Empty-body handling is a PAIR with `connectors/_lib/gmail/api.ts` — keep
  // the two arms in step. The `bodyPreview` arm is what stops a body-less
  // message from claiming completeness (a declared-full `body: ""` would
  // latch `body_complete = 1` and permanently hide the item from
  // `index.rebody`). Graph's ~255-char `bodyPreview` is still in the
  // `$select` projection and still fetched, so handing it over here costs
  // nothing and keeps the message searchable at `body_complete = 0`.
  const preview = typeof m.bodyPreview === "string" ? m.bodyPreview : "";
  const bodyInput: IndexedItemBodyInput = body === "" ? { bodyPreview: preview } : { body };
  const url = typeof m.webLink === "string" ? m.webLink : null;
  const modified = modifiedMsFromIso(m.lastModifiedDateTime ?? m.receivedDateTime, now);
  const addr = m.from?.emailAddress?.address;
  const fromName = m.from?.emailAddress?.name;
  const authorId =
    addr !== undefined && addr !== ""
      ? ctx.resolvePerson({
          canonicalEmail: addr,
          displayName: fromName !== undefined && fromName !== "" ? fromName : addr,
        })
      : null;

  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "email",
    externalId: id,
    title: subject.length > 512 ? subject.slice(0, 512) : subject,
    ...bodyInput,
    url,
    canonicalUrl: url,
    modifiedAt: modified,
    authorId,
    metadata: {
      receivedDateTime: m.receivedDateTime,
    },
    pinned: false,
    syncedAt: now,
  });
}

export type OutlookSyncableOptions = {
  ensureMicrosoftMcpRunning: () => Promise<void>;
};

export function createOutlookSyncable(options: OutlookSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMicrosoftMcpRunning();
      const token = await ctx.accessToken();

      let nextUrl: string | null = null;
      if (cursor !== null && cursor !== "") {
        const dec = decodeOutlookSyncCursor(cursor);
        nextUrl = dec?.nextUrl ?? null;
      }

      const { json, bytes } = await fetchMicrosoftGraphJson(
        ctx,
        token,
        nextUrl,
        `${GRAPH}/me/messages/delta?$top=${String(PAGE_SIZE)}` +
          `&$select=id,subject,bodyPreview,body,receivedDateTime,lastModifiedDateTime,webLink,from`,
        "Outlook",
      );
      const parsed = parseODataDeltaPage(json);
      const values = (parsed.value ?? []) as GraphMessage[];
      const now = Date.now();
      let upserted = 0;
      let deleted = 0;

      for (const msg of values) {
        const removed = msg["@removed"] !== undefined && msg["@removed"] !== null;
        const id = msg.id;
        if (removed && id !== undefined && id !== "") {
          deleteItemByServiceExternal(ctx.db, SERVICE_ID, id);
          deleted += 1;
          continue;
        }
        upsertMessage(ctx, msg, now);
        upserted += 1;
      }

      const { stored, hasMore } = nextCursorFromODataDeltaLinks(parsed, encodeOutlookSyncCursor);

      return {
        cursor: stored,
        itemsUpserted: upserted,
        itemsDeleted: deleted,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: bytes,
      };
    },
  };
}
