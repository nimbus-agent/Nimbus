import type { IndexedItemBodyInput } from "../index/item-store.ts";
import { stripQuotedTail } from "../string/email-quoted-text.ts";
import { plainTextFromHtmlLines } from "../string/html-plain-text-lines.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { gatewayZone } from "./_lib/zoned-time.ts";
import {
  decodeMicrosoftGraphDeltaCursor,
  fetchMicrosoftGraphJson,
  modifiedMsFromIso,
  parseODataDeltaPage,
} from "./microsoft-graph-sync-shared.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { type OutlookCalendarCursor, runOutlookCalendarStep } from "./outlook-calendar-step.ts";
import { OUTLOOK_MAIL_META_VERSION } from "./outlook-mail-meta.ts";
import { asRecord, numberField } from "./unknown-record.ts";

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
// Bumped again, "nimbus-outl2:" -> "nimbus-outl3:", when `isRead` joined the
// projection (Phase 10 MB1), for the same reason: an outl2 delta link would never
// return it. The mailbox re-lists ONCE.
// Bumped a third time, "nimbus-outl3:" -> "nimbus-outl4:", when the cursor became TWO streams
// (Phase 10 MB2b: `{ v: 2, mail, calendar }`). This bump invalidates nothing: `nimbus-outl3:` is
// still DECODED, as a mail-only cursor (its `nextUrl` becomes `mail.nextUrl`, calendar absent), so
// the mailbox is not re-listed a third time. outl1/outl2 still fall to the initial URL.
const CURSOR_PREFIX = "nimbus-outl4:";
const CURSOR_PREFIX_V3 = "nimbus-outl3:";
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
  isRead?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
  "@removed"?: { reason?: string };
};

export type { OutlookCalendarCursor } from "./outlook-calendar-step.ts";

export type OutlookSyncCursorV2 = {
  readonly v: 2;
  readonly mail: { readonly nextUrl: string | null };
  readonly calendar?: OutlookCalendarCursor;
};

export function encodeOutlookSyncCursor(c: OutlookSyncCursorV2): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCalendarHalf(v: unknown): OutlookCalendarCursor | undefined {
  const rec = asRecord(v);
  if (rec === undefined) return undefined;
  const windowStart = numberField(rec, "windowStart");
  const nextUrl = rec["nextUrl"];
  if (windowStart === undefined || (nextUrl !== null && typeof nextUrl !== "string")) {
    return undefined;
  }
  const checkedAt = numberField(rec, "checkedAt");
  const retryAt = numberField(rec, "retryAt");
  return {
    nextUrl,
    windowStart,
    ...(rec["draining"] === true ? { draining: true } : {}),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

/**
 * `nimbus-outl4:` is read as written; `nimbus-outl3:` is read as a mail-only cursor (so mail is not
 * reset); anything else (outl1, outl2, junk, a malformed mail half) is `undefined` and both streams
 * start fresh. A malformed CALENDAR half is dropped on its own: the calendar restarts, mail is kept.
 */
export function decodeOutlookSyncCursor(raw: string): OutlookSyncCursorV2 | undefined {
  const r = decodeNimbusJsonCursorObject(raw, CURSOR_PREFIX);
  if (r !== null) {
    const mail = asRecord(r["mail"]);
    const nextUrl = mail === undefined ? undefined : mail["nextUrl"];
    if (r["v"] !== 2 || mail === undefined || (nextUrl !== null && typeof nextUrl !== "string")) {
      return undefined;
    }
    const calendar = decodeCalendarHalf(r["calendar"]);
    return { v: 2, mail: { nextUrl }, ...(calendar === undefined ? {} : { calendar }) };
  }
  const legacy = decodeMicrosoftGraphDeltaCursor(raw, CURSOR_PREFIX_V3);
  return legacy === undefined ? undefined : { v: 2, mail: { nextUrl: legacy.nextUrl } };
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

  ctx.upsertItem({
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
      // Omission over guessing: only a boolean from Graph is recorded, so a row without it stays
      // below the metadata version and `index.rebody` can still recover it.
      ...(typeof m.isRead === "boolean"
        ? { is_read: m.isRead, meta_v: OUTLOOK_MAIL_META_VERSION }
        : {}),
    },
    pinned: false,
    syncedAt: now,
  });
}

export type OutlookSyncableOptions = {
  ensureMicrosoftMcpRunning: () => Promise<void>;
  /** Test seams; production passes none. */
  readonly now?: () => number;
  readonly zone?: string;
};

type MailStepResult = {
  readonly nextUrl: string | null;
  readonly upserted: number;
  readonly deleted: number;
  readonly bytes: number;
  readonly hasMore: boolean;
};

/** The mail stream, unchanged in behaviour: one delta page per run. */
async function runMailStep(
  ctx: SyncContext,
  token: string,
  nextUrl: string | null,
): Promise<MailStepResult> {
  const { json, bytes } = await fetchMicrosoftGraphJson(
    ctx,
    token,
    nextUrl,
    `${GRAPH}/me/messages/delta?$top=${String(PAGE_SIZE)}` +
      `&$select=id,subject,bodyPreview,body,receivedDateTime,lastModifiedDateTime,webLink,from,isRead`,
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
      ctx.deleteItem(SERVICE_ID, id);
      deleted += 1;
      continue;
    }
    upsertMessage(ctx, msg, now);
    upserted += 1;
  }

  const nextLink = parsed["@odata.nextLink"];
  const deltaLink = parsed["@odata.deltaLink"];
  const hasNext = typeof nextLink === "string" && nextLink !== "";
  const hasDelta = typeof deltaLink === "string" && deltaLink !== "";
  let stored: string | null = null;
  if (hasNext) stored = nextLink;
  else if (hasDelta) stored = deltaLink;
  return { nextUrl: stored, upserted, deleted, bytes, hasMore: hasNext };
}

export function createOutlookSyncable(options: OutlookSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMicrosoftMcpRunning();
      const token = await ctx.accessToken();

      const dec = cursor === null || cursor === "" ? undefined : decodeOutlookSyncCursor(cursor);
      // The mail result is computed FIRST: a calendar failure can never lose it, and a mail error
      // propagates exactly as it did before the calendar existed.
      const mail = await runMailStep(ctx, token, dec?.mail.nextUrl ?? null);
      const calendar = await runOutlookCalendarStep(
        ctx,
        token,
        dec?.calendar,
        options.now?.() ?? Date.now(),
        options.zone ?? gatewayZone(),
      );
      if (calendar.unresolved > 0) {
        ctx.logger.info(
          { serviceId: SERVICE_ID, calendar_unresolved: calendar.unresolved },
          "Outlook calendar events with a time zone that could not be resolved were indexed without start and end times",
        );
      }

      return {
        cursor: encodeOutlookSyncCursor({
          v: 2,
          mail: { nextUrl: mail.nextUrl },
          ...(calendar.half === undefined ? {} : { calendar: calendar.half }),
        }),
        itemsUpserted: mail.upserted + calendar.upserted,
        itemsDeleted: mail.deleted + calendar.deleted,
        hasMore: mail.hasMore || calendar.hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: mail.bytes + calendar.bytes,
      };
    },
  };
}
