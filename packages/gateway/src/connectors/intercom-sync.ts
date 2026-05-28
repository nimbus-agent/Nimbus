import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
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

/**
 * `intercom.token` is required. Intercom's API host is a fixed SaaS host
 * (`api.intercom.io`, US) — there is no host override key (EU/AU regional hosts
 * are a deferred follow-up). The connector no-ops unless the token is non-empty
 * after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<IntercomCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "intercom", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/**
 * Build `/conversations?per_page=150`, optionally with a `starting_after` cursor
 * (the opaque cursor string from the previous page's `pages.next` — Intercom's
 * forward cursor).
 */
function conversationsPath(startingAfter: string | null): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE) });
  if (startingAfter !== null) {
    params.set("starting_after", startingAfter);
  }
  return `/conversations?${params.toString()}`;
}

async function intercomGet(
  ctx: SyncContext,
  creds: IntercomCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Intercom uses `Authorization: Bearer <access-token>` (never logged) plus the
  // `Intercom-Version` + `Accept` request headers.
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Intercom-Version": "2.11",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "intercom GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /conversations` returns the Intercom list envelope
 * `{ type: "conversation.list", conversations: [...], pages: { next?: { page,
 * starting_after } | null, ... }, total_count }`. Extract the conversations
 * array and the next cursor defensively — a missing/malformed envelope yields an
 * empty page with a null cursor so the walk terminates.
 */
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

      // The first conversations page is the gating call: a FIRST-page http/parse
      // error maps to the pass-cursor-empty result (http keeps the prior cursor,
      // parse resets). Later-page errors just break, preserving whatever was
      // already collected. Intercom cursor-paginates: read
      // `pages.next.starting_after` and pass it forward until `pages.next` is
      // absent/null (or the MAX_PAGES cap stops the walk).
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
